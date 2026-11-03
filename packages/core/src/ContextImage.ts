import { createHash } from "node:crypto";
import { Effect, FileSystem, Schema } from "effect";
import { RemoteShell } from "#src/RemoteShell.ts";
import type { Server } from "#src/Server.ts";

// A Docker build context in this checkout: its directory and the files the image is built from.
export interface ImageContext {
  readonly dir: string;
  readonly files: ReadonlyArray<string>;
}

export class ImageBuildFailed extends Schema.TaggedError<ImageBuildFailed>()("ImageBuildFailed", {
  server: Schema.String,
  message: Schema.String,
}) {}

// Builds `palforge-<name>:<hash of the context files>` on the server unless that exact image is there.
export const ensureContextImage = Effect.fn("ensureContextImage")(function* (
  server: Server,
  name: string,
  context: ImageContext,
) {
  const shell = yield* RemoteShell;
  const fs = yield* FileSystem.FileSystem;

  const files = yield* Effect.forEach(context.files, (file) =>
    fs.readFileString(`${context.dir}/${file}`).pipe(
      Effect.map((content) => ({ file, content })),
      Effect.mapError(
        (cause) =>
          new ImageBuildFailed({
            server: server.name,
            message: `palctl builds palforge-${name} from its checkout, but could not read ${file}: ${cause.message}`,
          }),
      ),
    ),
  );

  const hash = createHash("sha256")
    .update(files.map(({ file, content }) => `${file}\n${content}`).join("\0"))
    .digest("hex")
    .slice(0, 12);

  const image = `palforge-${name}:${hash}`;

  const present = yield* shell.run(server, [
    "sh",
    "-c",
    'docker image inspect "$1" >/dev/null 2>&1 && echo present || true',
    "sh",
    image,
  ]);

  if (present.trim() === "present") {
    return image;
  }

  const dir = `${server.workDir}/${name}/${hash}`;

  yield* Effect.logInfo(`Building the ${image} image on ${server.name}`);

  yield* Effect.forEach(files, ({ file, content }) =>
    shell.run(
      server,
      ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", `${dir}/${file}`],
      content,
    ),
  );

  yield* shell.run(server, [
    "sh",
    "-c",
    'docker build -q -t "$1" "$2" < /dev/null > /dev/null',
    "sh",
    image,
    dir,
  ]);

  return image;
});
