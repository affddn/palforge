import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { PakFormatError, readPakIndex } from "#src/index.ts";
import type { PakSource } from "#src/index.ts";

// Writes the parts of a version 11 pak that the reader needs, laid out the way Unreal writes them.
class PakWriter {
  readonly #bytes: Array<number> = [];

  get length() {
    return this.#bytes.length;
  }

  u8(value: number) {
    this.#bytes.push(value);

    return this;
  }

  u32(value: number) {
    const view = new DataView(new ArrayBuffer(4));

    view.setUint32(0, value, true);

    return this.raw(new Uint8Array(view.buffer));
  }

  i32(value: number) {
    const view = new DataView(new ArrayBuffer(4));

    view.setInt32(0, value, true);

    return this.raw(new Uint8Array(view.buffer));
  }

  u64(value: number) {
    const view = new DataView(new ArrayBuffer(8));

    view.setBigUint64(0, BigInt(value), true);

    return this.raw(new Uint8Array(view.buffer));
  }

  raw(bytes: ArrayLike<number>) {
    this.#bytes.push(...Array.from(bytes));

    return this;
  }

  zeros(count: number) {
    return this.raw(new Uint8Array(count));
  }

  fstring(value: string) {
    if (/^[ -~]*$/u.test(value)) {
      return this.i32(value.length + 1)
        .raw(new TextEncoder().encode(value))
        .u8(0);
    }

    this.i32(-(value.length + 1));

    for (const unit of Array.from({ length: value.length }, (_, index) =>
      value.charCodeAt(index),
    )) {
      this.u8(unit & 0xff).u8(unit >>> 8);
    }

    return this.u8(0).u8(0);
  }

  toBytes() {
    return Uint8Array.from(this.#bytes);
  }
}

const memorySource = (bytes: Uint8Array): PakSource => ({
  size: Effect.succeed(bytes.byteLength),
  read: (offset, length) => Effect.succeed(bytes.subarray(offset, offset + length)),
});

interface Fixture {
  readonly magic: number;
  readonly version: number;
  readonly declaredEntries: number;
}

const vanilla: Fixture = { magic: 0x5a6f12e1, version: 11, declaredEntries: 4 };

const buildPak = (fixture: Fixture) => {
  const pak = new PakWriter().zeros(64);

  const encoded = new PakWriter();

  // Uncompressed, every field fits in 32 bits, 64 KiB block size.
  const plainTable = encoded.length;

  encoded
    .u32((1 << 31) | (1 << 30) | (1 << 29) | (65536 >>> 11))
    .u32(0)
    .u32(100);

  // Oodle (method 1), two blocks, explicit block size, 64-bit offset.
  const compressedTable = encoded.length;

  encoded
    .u32((1 << 30) | (1 << 29) | (1 << 23) | (2 << 6) | 0x3f)
    .u32(300_000)
    .u64(2 ** 33)
    .u32(300)
    .u32(200)
    .u32(120)
    .u32(80);

  const rootFile = encoded.length;

  encoded
    .u32((1 << 31) | (1 << 30) | (1 << 29))
    .u32(10)
    .u32(7);

  const encodedBytes = encoded.toBytes();

  const directoryIndex = new PakWriter()
    .u32(3)
    .fstring("/")
    .u32(1)
    .fstring("Pal.uplugin")
    .i32(rootFile)
    .fstring("Pal/Content/Pal/DataTable/")
    .u32(2)
    .fstring("DT_Table.uasset")
    .i32(plainTable)
    .fstring("DT_Table.uexp")
    .i32(compressedTable)
    .fstring("Pal/Content/Pal/Blueprint/")
    .u32(1)
    .fstring("BP_Größe.uasset")
    .i32(-1)
    .toBytes();

  const indexOffset = pak.length;

  const primaryIndexLength = (directoryIndexOffset: number) =>
    new PakWriter()
      .fstring("../../../")
      .u32(fixture.declaredEntries)
      .u64(0)
      .u32(0)
      .u32(1)
      .u64(directoryIndexOffset)
      .u64(directoryIndex.byteLength)
      .zeros(20)
      .u32(encodedBytes.byteLength)
      .raw(encodedBytes)
      .u32(1)
      // Listed entry: offset, size, uncompressed size, Oodle, hash, one block, flags, block size.
      .u64(5000)
      .u64(40)
      .u64(90)
      .u32(1)
      .zeros(20)
      .u32(1)
      .u64(5053)
      .u64(5093)
      .u8(0)
      .u32(65536)
      .toBytes();

  const indexLength = primaryIndexLength(0).byteLength;

  pak.raw(primaryIndexLength(indexOffset + indexLength)).raw(directoryIndex);

  pak
    .zeros(16)
    .u8(0)
    .u32(fixture.magic)
    .u32(fixture.version)
    .u64(indexOffset)
    .u64(indexLength)
    .zeros(20)
    .raw(new TextEncoder().encode("Oodle"))
    .zeros(32 * 5 - 5);

  return pak.toBytes();
};

const readIndex = (bytes: Uint8Array) => Effect.runPromise(readPakIndex(memorySource(bytes)));

const readError = (bytes: Uint8Array) =>
  Effect.runPromise(Effect.flip(readPakIndex(memorySource(bytes))));

describe("readPakIndex", () => {
  it("lists every file with its path relative to the mount point", async () => {
    const index = await readIndex(buildPak(vanilla));

    expect(index.mountPoint).toBe("../../../");
    expect(index.footer.compressionMethods).toEqual(["Oodle"]);

    expect(index.entries.map((entry) => entry.path)).toEqual([
      "Pal.uplugin",
      "Pal/Content/Pal/DataTable/DT_Table.uasset",
      "Pal/Content/Pal/DataTable/DT_Table.uexp",
      "Pal/Content/Pal/Blueprint/BP_Größe.uasset",
    ]);
  });

  it("decodes uncompressed, compressed and 64-bit entries", async () => {
    const index = await readIndex(buildPak(vanilla));
    const [, plain, compressed] = index.entries;

    expect(plain).toMatchObject({
      offset: 0,
      size: 100,
      uncompressedSize: 100,
      compression: "None",
    });

    expect(compressed).toMatchObject({
      offset: 2 ** 33,
      size: 200,
      uncompressedSize: 300,
      compression: "Oodle",
      compressionBlocks: 2,
      encrypted: false,
    });
  });

  it("decodes entries stored in full rather than bit-packed", async () => {
    const index = await readIndex(buildPak(vanilla));

    expect(index.entries.at(-1)).toMatchObject({
      offset: 5000,
      size: 40,
      uncompressedSize: 90,
      compression: "Oodle",
      compressionBlocks: 1,
    });
  });

  it("rejects a file that is not a pak", async () => {
    const error = await readError(buildPak({ ...vanilla, magic: 0x12345678 }));

    expect(error).toBeInstanceOf(PakFormatError);
    expect(error.message).toContain("magic");
  });

  it("rejects pak versions it was not written for", async () => {
    const error = await readError(buildPak({ ...vanilla, version: 8 }));

    expect(error.message).toContain("version 8");
  });

  it("rejects an index whose directory disagrees with its entry count", async () => {
    const error = await readError(buildPak({ ...vanilla, declaredEntries: 5 }));

    expect(error.message).toContain("declares 5");
  });

  it("fails with PakFormatError instead of a defect when the index is truncated", async () => {
    const pak = buildPak(vanilla);
    const footer = pak.subarray(pak.byteLength - 221);
    const view = new DataView(footer.buffer, footer.byteOffset);

    view.setBigUint64(33, BigInt(12), true);

    const error = await readError(pak);

    expect(error).toBeInstanceOf(PakFormatError);
  });
});
