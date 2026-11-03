import { RemoteShell } from "@palforge/core";
import type { Server } from "@palforge/core";
import { dumpMappings, installedBuild, parseBuildId } from "@palforge/mappings";
import { recipeFor } from "@palforge/open-pal";
import type { OpenPalConfig } from "@palforge/open-pal";
import { PalworldRest } from "@palforge/palworld-rest";
import { Duration, Effect, Option, Schedule, Schema } from "effect";
import { buildPack } from "#src/PackBuilder.ts";
import type { GameFiles } from "#src/PackBuilder.ts";
import { deployPack, PackDeployFailed } from "#src/PackDeploy.ts";
import type { DeployOptions } from "#src/PackDeploy.ts";

export const updateStages = ["detect", "stage", "mappings", "build", "switch", "soak"] as const;

export type UpdateStage = (typeof updateStages)[number];

export class GameUpdateFailed extends Schema.TaggedError<GameUpdateFailed>()("GameUpdateFailed", {
  server: Schema.String,
  stage: Schema.Literals(updateStages),
  message: Schema.String,
}) {}

export interface UpdateOptions {
  // Runs every stage against the build the server already runs, to prove the pipeline without a game update.
  readonly rehearse: boolean;
  // With `rehearse`: fail on purpose at this stage, to prove the server ends up running and healthy.
  readonly failAt?: UpdateStage | undefined;
  // How long to wait for players to leave before the announced restart.
  readonly waitForEmpty?: Duration.Input | undefined;
  // How long a restarted server runs before its FPS is checked (see DeployOptions).
  readonly settle?: Duration.Input | undefined;
}

export interface UpdateResult {
  readonly server: string;
  readonly from: string;
  readonly to: string;
  readonly updated: boolean;
}

const appId = "2394010";
const steamcmd = "/home/steam/steamcmd/steamcmd.sh";

// The public branch's build in `app_info_print` output; other branches and the depots list come before or after it.
export const publicBuildId = (appInfo: string) =>
  Option.fromNullishOr(
    /"branches"\s*\{\s*"public"\s*\{[^}]*?"buildid"\s+"(\d+)"/u.exec(appInfo)?.[1],
  );

// Steam's current public build, asked with the steamcmd inside the server image.
export const latestBuild = Effect.fn("latestBuild")(function* (server: Server) {
  const shell = yield* RemoteShell;

  const appInfo = yield* shell.run(server, [
    "docker",
    "run",
    "--rm",
    "--entrypoint",
    steamcmd,
    server.upstreamImage,
    "+login",
    "anonymous",
    "+app_info_update",
    "1",
    "+app_info_print",
    appId,
    "+quit",
  ]);

  return yield* Effect.fromOption(publicBuildId(appInfo)).pipe(
    Effect.mapError(
      () =>
        new GameUpdateFailed({
          server: server.name,
          stage: "detect",
          message: "steamcmd printed no public build ID",
        }),
    ),
  );
});

// Downloads `buildId` next to the live install, under `<workDir>/staging/<buildId>`, while the server keeps running.
export const stageBuild = Effect.fn("stageBuild")(function* (server: Server, buildId: string) {
  const shell = yield* RemoteShell;
  const root = `${server.workDir}/staging/${buildId}`;

  const failed = (message: string) =>
    new GameUpdateFailed({ server: server.name, stage: "stage", message });

  const onHost = (script: string, ...args: ReadonlyArray<string>) =>
    shell.run(server, ["sh", "-c", script, "sh", ...args]);

  yield* Effect.logInfo(`Downloading build ${buildId} for ${server.name} to ${root}`);

  // Older staged builds are not needed once a newer one is staged; they take about 5 GB each. steamcmd can only
  // install into a folder its `steam` user owns; otherwise it installs inside the container and reports success.
  // It can also fail with "Missing configuration" on a first run, so it gets three tries.
  yield* onHost(
    `set -eu
mkdir -p "$1"
find "$(dirname "$1")" -mindepth 1 -maxdepth 1 ! -path "$1" -exec rm -rf {} +
docker run --rm --user root -v "$1:/staging" --entrypoint chown "$3" steam:steam /staging
: > "$1.log"
for attempt in 1 2 3; do
  docker run --rm --user steam -v "$1:/staging" --entrypoint "$2" "$3" +force_install_dir /staging +login anonymous +app_update "$4" validate +quit >> "$1.log" 2>&1 || true
  if [ -f "$1/steamapps/appmanifest_$4.acf" ]; then break; fi
done`,
    root,
    steamcmd,
    server.upstreamImage,
    appId,
  );

  const manifest = yield* onHost(
    'cat "$1/steamapps/appmanifest_$2.acf" 2>/dev/null || true',
    root,
    appId,
  );

  const staged = parseBuildId(manifest);

  if (Option.isNone(staged)) {
    return yield* failed(`steamcmd did not install the game; see ${root}.log`);
  }

  // Steam serves only the latest public build, so a newer one may have shipped since detection.
  if (staged.value !== buildId) {
    return yield* failed(
      `Steam served build ${staged.value} while build ${buildId} was being staged`,
    );
  }

  const pak = yield* onHost(
    'test -s "$1/Pal/Content/Paks/Pal-LinuxServer.pak" && echo present || true',
    root,
  );

  if (pak.trim() !== "present") {
    return yield* failed(`The staged build has no game pak; see ${root}.log`);
  }

  return { root, buildId } satisfies GameFiles;
});

// Copies the staged build over the live install while the server is stopped, so the image's update-on-boot finds
// nothing to download. Game files go first and Steam's manifest last: if the copy breaks, the manifest still names
// the old build and the image reinstalls on the next start. Saves and installed paks are not in the staged build.
const copyStaged = (server: Server, staged: GameFiles, live: string) =>
  Effect.gen(function* () {
    const shell = yield* RemoteShell;

    yield* shell.run(server, [
      "sh",
      "-c",
      `set -eu
owner="$(stat -c %u:%g "$2/steamapps")"
rsync -a --chown="$owner" --exclude /steamapps/ --exclude /Pal/Saved/ "$1/" "$2/"
rsync -a --chown="$owner" "$1/steamapps/" "$2/steamapps/"`,
      "sh",
      staged.root,
      live,
    ]);
  });

const liveRoot = Effect.fn("liveRoot")(function* (server: Server) {
  const shell = yield* RemoteShell;

  return (yield* shell.run(server, [
    "docker",
    "inspect",
    "-f",
    '{{range .Mounts}}{{if eq .Destination "/palworld"}}{{.Source}}{{end}}{{end}}',
    server.container,
  ])).trim();
});

// Updates one server: detect, stage, mappings, build, switch. Every failure names its stage, and a failure while
// switching rolls the server back to vanilla on whichever build it then runs.
export const updateServer = Effect.fn("updateServer")(function* (
  server: Server,
  config: OpenPalConfig,
  options: UpdateOptions,
) {
  // The switch's rehearsed failure happens while the server is stopped (see `whileStopped`), not before it starts.
  const rehearsedFailure = (stage: UpdateStage) =>
    options.rehearse && options.failAt === stage && stage !== "switch"
      ? Effect.fail(
          new GameUpdateFailed({ server: server.name, stage, message: "Rehearsed failure" }),
        )
      : Effect.void;

  const stage = <A, E extends { readonly message: string }, R>(
    name: UpdateStage,
    run: Effect.Effect<A, E, R>,
  ) =>
    rehearsedFailure(name).pipe(
      Effect.andThen(run),
      Effect.mapError((error) =>
        error instanceof GameUpdateFailed
          ? error
          : new GameUpdateFailed({ server: server.name, stage: name, message: error.message }),
      ),
      Effect.tap(() => Effect.logInfo(`${server.name}: ${name} done`)),
    );

  const installed = yield* stage("detect", installedBuild(server));
  const latest = yield* stage("detect", latestBuild(server));

  if (latest === installed && !options.rehearse) {
    return {
      server: server.name,
      from: installed,
      to: latest,
      updated: false,
    } satisfies UpdateResult;
  }

  const staged = yield* stage("stage", stageBuild(server, latest));
  const hasFeatures = (yield* recipeFor(config)).length > 0;

  if (hasFeatures) {
    yield* stage("mappings", dumpMappings(server, latest));
  }

  const pack = yield* stage("build", buildPack(server, config, staged));
  const live = yield* stage("switch", liveRoot(server));

  // A rehearsed switch failure happens while the server is stopped, so it goes through the real rollback.
  const whileStopped = copyStaged(server, staged, live).pipe(
    Effect.andThen(
      options.rehearse && options.failAt === "switch"
        ? Effect.fail(
            new PackDeployFailed({
              server: server.name,
              message: "Rehearsed failure while switching",
            }),
          )
        : Effect.void,
    ),
  );

  const switchOptions: DeployOptions = {
    reason: "a game update",
    whileStopped,
    waitForEmpty: options.waitForEmpty,
    settle: options.settle,
  };

  yield* stage("switch", deployPack(server, pack, switchOptions));

  return { server: server.name, from: installed, to: latest, updated: true } satisfies UpdateResult;
});

// Watches a server for `period`: it must stay running without restarts, answer REST calls and hold 20 FPS.
export const soak = Effect.fn("soak")(function* (
  server: Server,
  period: Duration.Input,
  options: UpdateOptions,
) {
  const shell = yield* RemoteShell;
  const rest = yield* PalworldRest;

  const failed = (message: string) =>
    new GameUpdateFailed({ server: server.name, stage: "soak", message });

  if (options.rehearse && options.failAt === "soak") {
    return yield* failed("Rehearsed failure");
  }

  const state = () =>
    shell.run(server, [
      "docker",
      "inspect",
      "-f",
      "{{.State.Status}} {{.RestartCount}} {{.State.OOMKilled}}",
      server.container,
    ]);

  const startState = (yield* state()).trim();

  const check = Effect.gen(function* () {
    const now = (yield* state()).trim();

    if (now !== startState) {
      return yield* failed(`The container changed from "${startState}" to "${now}"`);
    }

    const fps = (yield* rest.metrics(server)).serverfps;

    if (fps < 20) {
      return yield* failed(`The server runs at ${fps} FPS`);
    }
  });

  yield* Effect.logInfo(
    `Watching ${server.name} for ${Duration.format(Duration.fromInputUnsafe(period))}`,
  );

  yield* check.pipe(
    Effect.repeat(Schedule.spaced("30 seconds")),
    Effect.timeoutOrElse({ duration: period, orElse: () => Effect.void }),
    Effect.mapError((error) => (error instanceof GameUpdateFailed ? error : failed(error.message))),
  );
});

export interface Rollout {
  readonly server: Server;
  readonly config: OpenPalConfig;
}

// Updates the canaries, watches them for `soakPeriod`, then updates the other servers one by one. A failure stops the
// rollout, so the servers that are not updated yet keep running their build.
export const updateAll = Effect.fn("updateAll")(function* (
  rollout: ReadonlyArray<Rollout>,
  soakPeriod: Duration.Input,
  options: UpdateOptions,
) {
  const canaries = rollout.filter((entry) => entry.server.canary);
  const others = rollout.filter((entry) => !entry.server.canary);
  const results: Array<UpdateResult> = [];

  for (const { server, config } of canaries) {
    const result = yield* updateServer(server, config, options);

    results.push(result);

    // A canary that does not stay healthy goes back to vanilla on its new build, and the rollout stops.
    if (result.updated) {
      yield* soak(server, soakPeriod, options).pipe(
        Effect.catchTag("GameUpdateFailed", (failure) =>
          deployPack(server, Option.none(), {
            reason: "a rollback after a failed update",
            settle: options.settle,
          }).pipe(
            Effect.matchEffect({
              onFailure: (rollback) =>
                Effect.fail(
                  new GameUpdateFailed({
                    server: server.name,
                    stage: "soak",
                    message: `${failure.message}. Rolling back to vanilla also failed: ${rollback.message}`,
                  }),
                ),
              onSuccess: () =>
                Effect.fail(
                  new GameUpdateFailed({
                    server: server.name,
                    stage: "soak",
                    message: `${failure.message}. Rolled back to vanilla.`,
                  }),
                ),
            }),
          ),
        ),
      );
    }
  }

  for (const { server, config } of others) {
    results.push(yield* updateServer(server, config, options));
  }

  return results;
});
