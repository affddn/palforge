import { RemoteShell } from "@palforge/core";
import type { Server } from "@palforge/core";
import { PakReadError } from "@palforge/unreal-pak";
import type { PakSource } from "@palforge/unreal-pak";
import { Effect } from "effect";
import { Base64 } from "effect/encoding";

// Where thijsvanloef/palworld-server-docker installs the game inside its container.
export const gamePakPath = "/palworld/Pal/Content/Paks/Pal-LinuxServer.pak";

// Reads byte ranges of a file inside the server's container over SSH, base64-encoded because RemoteShell returns text.
export const remotePak = Effect.fn("remotePak")(function* (server: Server, path: string) {
  const shell = yield* RemoteShell;

  const inContainer = (script: string, ...args: ReadonlyArray<string>) =>
    shell.run(server, ["docker", "exec", server.container, "sh", "-c", script, "sh", ...args]).pipe(
      Effect.mapError(
        (cause) =>
          new PakReadError({
            message: `Could not read ${path} on ${server.name}: ${cause.message}`,
            cause,
          }),
      ),
    );

  const size = inContainer('stat -c %s "$1"', path).pipe(
    Effect.map((stdout) => Number(stdout.trim())),
    Effect.filterOrFail(
      Number.isSafeInteger,
      (size) =>
        new PakReadError({ message: `stat returned ${size} as the size of ${path}`, cause: size }),
    ),
  );

  const read = (offset: number, length: number) =>
    inContainer(
      'dd if="$1" bs=1M iflag=skip_bytes,count_bytes skip="$2" count="$3" status=none | base64 -w 0',
      path,
      String(offset),
      String(length),
    ).pipe(
      Effect.flatMap((encoded) => Effect.fromResult(Base64.decode(encoded.trim()))),
      Effect.mapError(
        (cause) =>
          new PakReadError({
            message: `Could not read ${length} bytes at ${offset} of ${path}: ${cause.message}`,
            cause,
          }),
      ),
      Effect.filterOrFail(
        (bytes) => bytes.byteLength === length,
        (bytes) =>
          new PakReadError({
            message: `Read ${bytes.byteLength} of ${length} bytes at ${offset} of ${path}`,
            cause: bytes.byteLength,
          }),
      ),
    );

  return { size, read } satisfies PakSource;
});
