import { RemoteShell } from "@palforge/core";
import type { Server } from "@palforge/core";
import { Effect, Option, Schedule, Schema } from "effect";

// thijsvanloef/palworld-server-docker:wine 2.8.1 runs the Windows server under Wine with UE4SS.
const dumperImage =
  "thijsvanloef/palworld-server-docker:wine@sha256:10ee9d9da30bb4bafbf59842037377cbe4f81eaf6ce68169761af32c5121621a";

// The Okaetsu build ships Palworld's enum layout fix and exposes DumpUSMAP to Lua.
const ue4ssUrl =
  "https://github.com/Okaetsu/RE-UE4SS/releases/download/2281fa31/UE4SS-Palworld-g2281fa31.zip";

const dumperContainer = "palforge-mappings-dumper";
const appManifest = "steamapps/appmanifest_2394010.acf";

// Installed by the image as a UE4SS Lua mod; dumps once, 15 seconds after the world has loaded.
export const dumperLua = `local done = false
RegisterInitGameStatePostHook(function()
  if done then return end
  done = true
  ExecuteWithDelay(15000, function()
    ExecuteInGameThread(function()
      DumpUSMAP()
      print("[palforge] DumpUSMAP returned\\n")
    end)
  end)
end)
`;

export class MappingsDumpFailed extends Schema.TaggedError<MappingsDumpFailed>()(
  "MappingsDumpFailed",
  {
    server: Schema.String,
    message: Schema.String,
  },
) {}

class DumpInProgress extends Schema.TaggedError<DumpInProgress>()("DumpInProgress", {}) {}

export interface Mappings {
  readonly buildId: string;
  readonly path: string;
  readonly generated: boolean;
}

export const parseBuildId = (manifest: string) =>
  Option.fromNullishOr(/"buildid"\s+"(\d+)"/u.exec(manifest)?.[1]);

// The status script prints `completed` once UE4SS logged success, then `file=<name>` for each .usmap on disk.
// UE4SS buffers its log, so its own "Output file:" line can stay unwritten until something else is logged.
export const dumpedFile = (status: string) =>
  Option.fromNullishOr(/^completed$[\s\S]*?^file=(\S+\.usmap)$/mu.exec(status)?.[1]);

// The Steam build the server's container runs.
export const installedBuild = Effect.fn("installedBuild")(function* (server: Server) {
  const shell = yield* RemoteShell;

  const manifest = yield* shell.run(server, [
    "docker",
    "exec",
    server.container,
    "cat",
    `/palworld/${appManifest}`,
  ]);

  return yield* Effect.fromOption(parseBuildId(manifest)).pipe(
    Effect.mapError(
      () =>
        new MappingsDumpFailed({
          server: server.name,
          message: `No Steam build ID in ${server.container}:/palworld/${appManifest}`,
        }),
    ),
  );
});

// Mappings for `build`, by default the build the server runs. During an update it is the staged build, which the
// dumper downloads as the latest public build.
export const dumpMappings = Effect.fn("dumpMappings")(function* (server: Server, build?: string) {
  const shell = yield* RemoteShell;
  const failed = (message: string) => new MappingsDumpFailed({ server: server.name, message });

  // Scripts receive their values as positional arguments, so nothing is interpolated into shell code.
  const onHost = (script: string, ...args: ReadonlyArray<string>) =>
    shell.run(server, ["sh", "-c", script, "sh", ...args]);

  const buildIdIn = (manifest: string, where: string) =>
    Effect.fromOption(parseBuildId(manifest)).pipe(
      Effect.mapError(() => failed(`No Steam build ID in ${where}`)),
    );

  const buildId = build ?? (yield* installedBuild(server));

  const mappingsPath = `${server.workDir}/mappings/${buildId}.usmap`;

  if ((yield* onHost('test -f "$1" && echo cached || true', mappingsPath)).trim() === "cached") {
    return { buildId, path: mappingsPath, generated: false } satisfies Mappings;
  }

  // The dumper keeps its Windows game install between runs, so a later dump only downloads the update.
  const dumperDir = `${server.workDir}/mappings-dumper`;

  yield* Effect.logInfo(
    `Dumping mappings for build ${buildId} on ${server.name}; the first run downloads about 6 GB`,
  );

  yield* onHost(
    `set -eu
mod="$1/palworld/Mods/NativeMods/UsmapDump/Mods/UsmapDump"
mkdir -p "$mod/Scripts"
printf '%s' "$2" > "$mod/Scripts/main.lua"
touch "$mod/enabled.txt"
chown -R 1000:1000 "$1/palworld"
docker rm -f "$3" >/dev/null 2>&1 || true
rm -f "$1"/palworld/Pal/Binaries/Win64/ue4ss/*.usmap
docker run -d --name "$3" --memory 4g --memory-swap 4g --cpus 2 --cpu-shares 256 \\
  -v "$1/palworld:/palworld" -e PUID=1000 -e PGID=1000 -e PLAYERS=1 -e SERVER_NAME="$3" \\
  -e COMMUNITY=false -e UPDATE_ON_BOOT=true -e MOD_ENABLED=true -e MOD_UPDATE_ON_BOOT=true -e MOD_DEBUG=true \\
  -e MOD_URL_UE4SS="$5" -e MOD_ID_PALSCHEMA= -e MOD_USE_PALDEFENDER=false -e MOD_IDS= \\
  -e BACKUP_ENABLED=false -e AUTO_UPDATE_ENABLED=false -e AUTO_REBOOT_ENABLED=false \\
  -e RCON_ENABLED=false -e REST_API_ENABLED=false "$4" >/dev/null`,
    dumperDir,
    dumperLua,
    dumperContainer,
    dumperImage,
    ue4ssUrl,
  );

  const outcome = Effect.gen(function* () {
    const status = yield* onHost(
      `if docker logs "$1" 2>&1 | grep -q "Mappings Generation Completed Successfully"; then
  echo completed
  for file in "$2"/palworld/Pal/Binaries/Win64/ue4ss/*.usmap; do [ -f "$file" ] && echo "file=\${file##*/}"; done
fi
docker inspect -f "running={{.State.Running}}" "$1"`,
      dumperContainer,
      dumperDir,
    );

    const written = dumpedFile(status);

    if (Option.isSome(written)) {
      return written.value;
    }

    return yield* status.includes("running=true")
      ? new DumpInProgress()
      : failed(
          `The dumper exited without writing mappings; see \`docker logs ${dumperContainer}\``,
        );
  });

  // A failed dumper is only stopped, so its logs stay readable.
  const file = yield* outcome.pipe(
    Effect.retry({
      schedule: Schedule.spaced("15 seconds"),
      while: (error) => error instanceof DumpInProgress,
    }),
    Effect.timeoutOrElse({
      duration: "60 minutes",
      orElse: () => Effect.fail(failed("The dumper did not finish within 60 minutes")),
    }),
    Effect.ensuring(Effect.ignore(onHost('docker stop -t 30 "$1" >/dev/null', dumperContainer))),
  );

  const dumperBuildId = yield* buildIdIn(
    yield* onHost('cat "$1/palworld/$2"', dumperDir, appManifest),
    `${dumperDir}/palworld/${appManifest}`,
  );

  // Steam can ship another update between choosing the build and the dumper's download.
  if (dumperBuildId !== buildId) {
    return yield* failed(
      `The dumper downloaded build ${dumperBuildId}, but mappings were wanted for build ${buildId}`,
    );
  }

  const header = yield* onHost(
    `set -eu
mkdir -p "$(dirname "$2")"
cp "$1" "$2.partial"
head -c 3 "$2.partial" | od -An -tx1 | tr -d ' \\n'`,
    `${dumperDir}/palworld/Pal/Binaries/Win64/ue4ss/${file}`,
    mappingsPath,
  );

  // A .usmap starts with the magic 0x30C4 and a format version of at least 4 (large enums).
  if (!/^c430(0[4-9a-f]|[1-9a-f][0-9a-f])$/u.test(header.trim())) {
    return yield* failed(`${file} does not start like a .usmap (got ${header.trim()})`);
  }

  yield* onHost('mv "$1.partial" "$1" && docker rm "$2" >/dev/null', mappingsPath, dumperContainer);

  return { buildId, path: mappingsPath, generated: true } satisfies Mappings;
});
