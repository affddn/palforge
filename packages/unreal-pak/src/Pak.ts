import { Effect, Schema } from "effect";
import { ByteCursor } from "#src/ByteCursor.ts";

// Layout follows Unreal's FPakInfo, FPakFile::LoadIndexInternal and FPakFile::DecodePakEntry for pak version 11 (UE 5.1).
export const footerSize = 221;

const footerMagic = 0x5a6f12e1;
const supportedVersion = 11;
const compressionMethodSlots = 5;
const compressionMethodNameSize = 32;

export class PakFormatError extends Schema.TaggedError<PakFormatError>()("PakFormatError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class PakReadError extends Schema.TaggedError<PakReadError>()("PakReadError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

// Random access to the bytes of one pak file, wherever it lives.
export interface PakSource {
  readonly size: Effect.Effect<number, PakReadError>;
  read(offset: number, length: number): Effect.Effect<Uint8Array, PakReadError>;
}

export interface PakFooter {
  readonly version: number;
  readonly indexOffset: number;
  readonly indexSize: number;
  readonly compressionMethods: ReadonlyArray<string>;
}

export interface PakEntry {
  // Relative to the mount point, e.g. `Pal/Content/Pal/DataTable/Character/DT_PalMonsterParameter.uasset`.
  readonly path: string;
  // Where the entry's own header starts; the data follows that header.
  readonly offset: number;
  readonly size: number;
  readonly uncompressedSize: number;
  // `None` when stored uncompressed, otherwise a name from the footer such as `Oodle`.
  readonly compression: string;
  readonly compressionBlocks: number;
  readonly encrypted: boolean;
}

export interface PakIndex {
  readonly mountPoint: string;
  readonly footer: PakFooter;
  readonly entries: ReadonlyArray<PakEntry>;
}

interface Region {
  readonly offset: number;
  readonly size: number;
}

interface PrimaryIndex {
  readonly mountPoint: string;
  readonly entryCount: number;
  readonly directoryIndex: Region;
  readonly encodedEntries: Uint8Array;
  readonly listedEntries: ReadonlyArray<Omit<PakEntry, "path">>;
}

const decoding = <A>(what: string, decode: () => A) =>
  Effect.try({
    try: decode,
    catch: (cause) =>
      new PakFormatError({
        message: `Could not decode the pak ${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });

const compressionName = (footer: PakFooter, methodIndex: number) => {
  if (methodIndex === 0) {
    return "None";
  }

  const name = footer.compressionMethods[methodIndex - 1];

  if (name === undefined) {
    throw new RangeError(`compression method ${methodIndex} is not named in the footer`);
  }

  return name;
};

export const decodeFooter = (bytes: Uint8Array) =>
  decoding("footer", (): PakFooter => {
    const cursor = new ByteCursor(bytes);

    cursor.bytes(16);
    const encryptedIndex = cursor.u8() !== 0;
    const magic = cursor.u32();
    const version = cursor.u32();

    if (magic !== footerMagic) {
      throw new Error(`magic is 0x${magic.toString(16)}, not 0x${footerMagic.toString(16)}`);
    }

    if (version !== supportedVersion) {
      throw new Error(`version ${version} is not supported (only ${supportedVersion})`);
    }

    if (encryptedIndex) {
      throw new Error("the index is encrypted");
    }

    const indexOffset = cursor.u64();
    const indexSize = cursor.u64();

    cursor.bytes(20);

    const compressionMethods = Array.from({ length: compressionMethodSlots }, () =>
      new TextDecoder("latin1")
        .decode(cursor.bytes(compressionMethodNameSize))
        .replace(/\0.*$/su, ""),
    ).filter((name) => name !== "");

    return { version, indexOffset, indexSize, compressionMethods };
  });

const readListedEntry = (cursor: ByteCursor, footer: PakFooter) => {
  const offset = cursor.u64();
  const size = cursor.u64();
  const uncompressedSize = cursor.u64();
  const methodIndex = cursor.u32();

  cursor.bytes(20);

  const compressionBlocks = methodIndex === 0 ? 0 : cursor.u32();

  cursor.bytes(compressionBlocks * 16);

  const flags = cursor.u8();

  cursor.u32();

  return {
    offset,
    size,
    uncompressedSize,
    compression: compressionName(footer, methodIndex),
    compressionBlocks,
    encrypted: (flags & 1) !== 0,
  };
};

export const decodePrimaryIndex = (bytes: Uint8Array, footer: PakFooter) =>
  decoding("index", (): PrimaryIndex => {
    const cursor = new ByteCursor(bytes);
    const mountPoint = cursor.fstring();
    const entryCount = cursor.u32();

    cursor.bytes(8);

    if (cursor.bool()) {
      cursor.bytes(8 + 8 + 20);
    }

    if (!cursor.bool()) {
      throw new Error("the pak has no full directory index, so its file names are unknown");
    }

    const directoryIndex = { offset: cursor.u64(), size: cursor.u64() };

    cursor.bytes(20);

    const encodedEntries = cursor.bytes(cursor.u32());
    const listedCount = cursor.u32();

    const listedEntries = Array.from({ length: listedCount }, () =>
      readListedEntry(cursor, footer),
    );

    return { mountPoint, entryCount, directoryIndex, encodedEntries, listedEntries };
  });

// Bit layout of the first word: 0-5 block size >> 11 (0x3f means an explicit u32 follows), 6-21 block count,
// 22 encrypted, 23-28 compression method, 29 size fits in u32, 30 uncompressed size fits in u32, 31 offset fits in u32.
const decodeEncodedEntry = (encoded: ByteCursor, location: number, footer: PakFooter) => {
  encoded.seek(location);

  const bits = encoded.u32();

  if ((bits & 0x3f) === 0x3f) {
    encoded.u32();
  }

  const methodIndex = (bits >>> 23) & 0x3f;
  const offset = (bits & (1 << 31)) === 0 ? encoded.u64() : encoded.u32();
  const uncompressedSize = (bits & (1 << 30)) === 0 ? encoded.u64() : encoded.u32();

  const size =
    methodIndex === 0 ? uncompressedSize : (bits & (1 << 29)) === 0 ? encoded.u64() : encoded.u32();

  return {
    offset,
    size,
    uncompressedSize,
    compression: compressionName(footer, methodIndex),
    compressionBlocks: (bits >>> 6) & 0xffff,
    encrypted: (bits & (1 << 22)) !== 0,
  };
};

// Directory names end in `/` and the root directory is `/` itself.
const joinPath = (directory: string, file: string) =>
  directory === "/" ? file : `${directory.replace(/^\//u, "")}${file}`;

export const decodeDirectoryIndex = (bytes: Uint8Array, primary: PrimaryIndex, footer: PakFooter) =>
  decoding("directory index", (): ReadonlyArray<PakEntry> => {
    const cursor = new ByteCursor(bytes);
    const encoded = new ByteCursor(primary.encodedEntries);
    const entries: Array<PakEntry> = [];
    const directoryCount = cursor.u32();

    for (let directory = 0; directory < directoryCount; directory += 1) {
      const directoryName = cursor.fstring();
      const fileCount = cursor.u32();

      for (let file = 0; file < fileCount; file += 1) {
        const path = joinPath(directoryName, cursor.fstring());
        const location = cursor.i32();

        // A negative location -(n + 1) points at the n-th entry stored in full after the encoded ones.
        const listed = location < 0 ? primary.listedEntries[-(location + 1)] : undefined;

        if (location < 0 && listed === undefined) {
          throw new RangeError(
            `${path} points at listed entry ${-(location + 1)}, which does not exist`,
          );
        }

        entries.push({ path, ...(listed ?? decodeEncodedEntry(encoded, location, footer)) });
      }
    }

    if (entries.length !== primary.entryCount) {
      throw new Error(
        `the directory index names ${entries.length} files but the index declares ${primary.entryCount}`,
      );
    }

    return entries;
  });

export const readPakIndex = Effect.fn("readPakIndex")(function* (source: PakSource) {
  const fileSize = yield* source.size;
  const footer = yield* decodeFooter(yield* source.read(fileSize - footerSize, footerSize));

  const primary = yield* decodePrimaryIndex(
    yield* source.read(footer.indexOffset, footer.indexSize),
    footer,
  );

  const entries = yield* decodeDirectoryIndex(
    yield* source.read(primary.directoryIndex.offset, primary.directoryIndex.size),
    primary,
    footer,
  );

  return { mountPoint: primary.mountPoint, footer, entries } satisfies PakIndex;
});
