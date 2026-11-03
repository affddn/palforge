import { createHash } from "node:crypto";
import { RemoteShell } from "@palforge/core";
import type { Server } from "@palforge/core";
import { composeOf, maintain, MaintenanceFailed } from "@palforge/maintenance";
import type { MaintenanceStep } from "@palforge/maintenance";
import { serverImageContext } from "@palforge/server-image";
import type { Duration } from "effect";
import { Effect, FileSystem, Option, Schema } from "effect";
import { packFile } from "#src/PackBuilder.ts";
import type { BuiltPack } from "#src/PackBuilder.ts";

// The tag the operator's compose file points at; palctl moves it to the guarded build of their upstream image.
export const serverImage = "palforge/palworld-server:current";

const manifestFile = "OpenPal_P.manifest.json";

export class PackDeployFailed extends Schema.TaggedError<PackDeployFailed>()("PackDeployFailed", {
  server: Schema.String,
  message: Schema.String,
}) {}

export interface Deployment {
  readonly pack: Option.Option<BuiltPack>;
  readonly fps: number;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const remote = Effect.fn("remote")(function* (server: Server) {
  const shell = yield* RemoteShell;
  const failed = (message: string) => new PackDeployFailed({ server: server.name, message });

  const onHost = (script: string, ...args: ReadonlyArray<string>) =>
    shell.run(server, ["bash", "-c", script, "bash", ...args]);

  const inspect = (format: string) =>
    onHost('docker inspect -f "$1" "$2"', format, server.container).pipe(
      Effect.map((out) => out.trim()),
    );

  return { shell, failed, onHost, inspect };
});

// Builds the operator's upstream image with the guard added, unless that exact build exists, and tags it current.
export const ensureServerImage = Effect.fn("ensureServerImage")(function* (server: Server) {
  const { shell, failed, onHost } = yield* remote(server);
  const fs = yield* FileSystem.FileSystem;

  const files = yield* Effect.forEach(serverImageContext.files, (file) =>
    fs.readFileString(`${serverImageContext.dir}/${file}`).pipe(
      Effect.map((content) => ({ file, content })),
      Effect.mapError((cause) =>
        failed(`Could not read the server image's ${file}: ${cause.message}`),
      ),
    ),
  );

  const upstream = (yield* onHost(
    'docker image inspect -f "{{index .RepoDigests 0}}" "$1" 2>/dev/null || true',
    server.upstreamImage,
  )).trim();

  if (upstream === "") {
    return yield* failed(`${server.upstreamImage} is not on ${server.sshHost}; pull it first`);
  }

  const contextHash = sha256(
    files.map(({ file, content }) => `${file}\n${content}`).join("\0"),
  ).slice(0, 12);

  const tag = `palforge/palworld-server:${sha256(upstream).slice(0, 12)}-${contextHash}`;

  const present = yield* onHost(
    'docker image inspect "$1" >/dev/null 2>&1 && echo present || true',
    tag,
  );

  if (present.trim() !== "present") {
    const context = `${server.workDir}/server-image/${contextHash}`;

    yield* Effect.logInfo(`Building ${tag} from ${upstream} on ${server.name}`);

    yield* Effect.forEach(files, ({ file, content }) =>
      shell.run(
        server,
        [
          "bash",
          "-c",
          'mkdir -p "$(dirname "$1")" && cat > "$1" && chmod +x "$1"',
          "bash",
          `${context}/${file}`,
        ],
        content,
      ),
    );

    yield* onHost(
      'docker build -q --build-arg UPSTREAM="$1" -t "$2" "$3" < /dev/null > /dev/null',
      upstream,
      tag,
      context,
    );
  }

  yield* onHost('docker tag "$1" "$2"', tag, serverImage);

  return tag;
});

export interface DeployOptions {
  // How long to wait for the last player to leave before the announced countdown, which follows either way.
  readonly waitForEmpty?: Duration.Input | undefined;
  // Runs while the server is stopped, before the pack is installed, with the same rollback; e.g. copying in a staged
  // game update.
  readonly whileStopped?: MaintenanceStep | undefined;
  // What players are told the restart is for.
  readonly reason?: string | undefined;
  // How long the server runs before its FPS is checked; FPS is low while the world loads. Default 30 seconds.
  readonly settle?: Duration.Input | undefined;
}

// Stops the server, installs the pack (or removes it when there is none), starts it and checks it. A server that
// is not healthy afterwards is rolled back to vanilla.
export const deployPack = Effect.fn("deployPack")(function* (
  server: Server,
  pack: Option.Option<BuiltPack>,
  options: DeployOptions = {},
) {
  const { failed, onHost, inspect } = yield* remote(server);

  // The start-time guard protects an installed pack; a server without one can keep its own image.
  if (Option.isSome(pack)) {
    yield* ensureServerImage(server);
  }

  const { compose, service, files } = yield* composeOf(server);

  // The image compose will start, which after an edit to the compose file is not yet the one running.
  const configuredImage = (yield* compose("config", "--images", service)).trim();

  if (Option.isSome(pack) && configuredImage !== serverImage) {
    return yield* failed(
      `${files} starts ${configuredImage}, which has no open-pal start-time guard. Set the ${service} service's image to ${serverImage} with pull_policy: never, then deploy again.`,
    );
  }

  const gameDir = yield* inspect(
    '{{range .Mounts}}{{if eq .Destination "/palworld"}}{{.Source}}{{end}}{{end}}',
  );

  const paks = `${gameDir}/Pal/Content/Paks`;

  const removePack = onHost('rm -f "$1/~mods/$2" "$1/~mods/$3"', paks, packFile, manifestFile);

  const install = Option.match(pack, {
    onNone: () => removePack,
    onSome: (built) =>
      onHost(
        `set -eu
owner="$(stat -c %u:%g "$1")"
mkdir -p "$1/~mods"
install -o "\${owner%:*}" -g "\${owner#*:}" -m 0644 "$2" "$1/~mods/$4"
install -o "\${owner%:*}" -g "\${owner#*:}" -m 0644 "$3" "$1/~mods/$5"
chown "$owner" "$1/~mods"`,
        paks,
        built.pak,
        `${built.dir}/manifest.json`,
        packFile,
        manifestFile,
      ),
  });

  // The image's log pipeline timestamps each line and upper-cases its tag, so the guard's lines read `[OPEN-PAL]`.
  // A crash writes binary data to the log, which makes plain grep stop printing lines.
  const guardAccepted = Effect.gen(function* () {
    const startedAt = yield* inspect("{{.State.StartedAt}}");

    const guardLog = yield* onHost(
      'docker logs --since "$2" "$1" 2>&1 | grep -a -i "\\[open-pal\\]" || true',
      server.container,
      startedAt,
    );

    if (!guardLog.includes("OpenPal_P.pak matches game build")) {
      return yield* failed(
        `The start-time guard did not accept the pack: ${guardLog.trim() || "it logged nothing"}`,
      );
    }

    const open = yield* onHost(
      'ls -l /proc/$(pgrep -f PalServer-Linux-Shipping | head -n 1)/fd 2>/dev/null | grep -c "/~mods/$1" || true',
      packFile,
    );

    if (open.trim() === "0") {
      return yield* failed("The server started but does not have OpenPal_P.pak open");
    }
  });

  const { fps } = yield* maintain(server, {
    reason: options.reason ?? "a quality-of-life update",
    waitForEmpty: options.waitForEmpty,
    settle: options.settle,
    whileStopped: (options.whileStopped ?? Effect.void).pipe(Effect.andThen(install)),
    afterStart: Option.isSome(pack) ? guardAccepted : undefined,
    undo: removePack,
    undone: "vanilla",
  }).pipe(
    Effect.mapError((error) =>
      error instanceof MaintenanceFailed
        ? new PackDeployFailed({ server: server.name, message: error.message })
        : error,
    ),
  );

  return { pack, fps } satisfies Deployment;
});
