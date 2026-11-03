import { RemoteShell } from "@palforge/core";
import type { Server } from "@palforge/core";
import { PalworldRest } from "@palforge/palworld-rest";
import { Duration, Effect, Schedule, Schema } from "effect";

// Below this the server is struggling; a healthy Palworld server holds about 60.
const minimumFps = 20;

export class MaintenanceFailed extends Schema.TaggedError<MaintenanceFailed>()(
  "MaintenanceFailed",
  {
    server: Schema.String,
    message: Schema.String,
  },
) {}

class NotReady extends Schema.TaggedError<NotReady>()("NotReady", { reason: Schema.String }) {}

// A change made around a restart. Its errors only need a message, which ends up in MaintenanceFailed.
export type MaintenanceStep = Effect.Effect<
  void,
  { readonly _tag: string; readonly message: string },
  RemoteShell | PalworldRest
>;

export interface MaintenanceOptions {
  // What players are told the restart is for.
  readonly reason: string;
  // How long to wait for the last player to leave before the announced countdown, which follows either way.
  readonly waitForEmpty?: Duration.Input | undefined;
  // How long the server runs before its FPS is checked; FPS is low while the world loads. Default 30 seconds.
  readonly settle?: Duration.Input | undefined;
  // The change, made while the server is stopped.
  readonly whileStopped: MaintenanceStep;
  // Checks that the change works, once the server is up and answering.
  readonly afterStart?: MaintenanceStep | undefined;
  // Reverts the change while the server is stopped again. It runs after any failure, so it must cope with a change
  // that was only partly made.
  readonly undo: MaintenanceStep;
  // What the server runs once `undo` is done, for messages: "vanilla" or "its saves from before the edit".
  readonly undone: string;
}

export interface Maintenance {
  readonly fps: number;
}

const onHost = (server: Server, script: string, ...args: ReadonlyArray<string>) =>
  RemoteShell.use((shell) => shell.run(server, ["bash", "-c", script, "bash", ...args]));

const inspect = (server: Server, format: string) =>
  onHost(server, 'docker inspect -f "$1" "$2"', format, server.container).pipe(
    Effect.map((out) => out.trim()),
  );

// Shows a message to every player in the game.
export const announce = (server: Server, message: string) =>
  RemoteShell.use((shell) =>
    shell.run(
      server,
      ["docker", "exec", "-i", server.container, "rest-cli", "announce", "-"],
      JSON.stringify({ message }),
    ),
  );

// Runs `docker compose` for the server's service the way its labels say it was started.
export const composeOf = Effect.fn("composeOf")(function* (server: Server) {
  const label = (name: string) => inspect(server, `{{index .Config.Labels "${name}"}}`);
  const dir = yield* label("com.docker.compose.project.working_dir");
  const files = yield* label("com.docker.compose.project.config_files");
  const project = yield* label("com.docker.compose.project");
  const service = yield* label("com.docker.compose.service");

  const compose = (...args: ReadonlyArray<string>) =>
    onHost(
      server,
      `IFS=, read -ra files <<< "$2"
flags=()
for file in "\${files[@]}"; do flags+=(-f "$file"); done
dir="$1" project="$3"
shift 3
docker compose --project-directory "$dir" -p "$project" "\${flags[@]}" "$@"`,
      dir,
      files,
      project,
      ...args,
    );

  return { compose, service, files };
});

// Announces, saves, backs up and stops the server, makes the change, starts it and checks it. A server that fails
// any step after the stop is stopped again, has the change undone and is started; the error says how that went.
export const maintain = Effect.fn("maintain")(function* (
  server: Server,
  options: MaintenanceOptions,
) {
  const shell = yield* RemoteShell;
  const rest = yield* PalworldRest;
  const failed = (message: string) => new MaintenanceFailed({ server: server.name, message });
  const { compose, service } = yield* composeOf(server);

  const playersOnline = rest.players(server).pipe(Effect.map((list) => list.players.length));
  const firstCount = yield* playersOnline;
  const waitForEmpty = options.waitForEmpty;

  const online =
    firstCount > 0 && waitForEmpty !== undefined
      ? yield* Effect.logInfo(
          `${firstCount} player(s) on ${server.name}; waiting up to ${Duration.format(Duration.fromInputUnsafe(waitForEmpty))} for them to leave`,
        ).pipe(
          Effect.andThen(
            playersOnline.pipe(
              Effect.repeat({
                schedule: Schedule.spaced("30 seconds"),
                until: (count) => count === 0,
              }),
            ),
          ),
          Effect.timeoutOrElse({ duration: waitForEmpty, orElse: () => playersOnline }),
        )
      : firstCount;

  if (online > 0) {
    yield* announce(
      server,
      `The server restarts in 60 seconds for ${options.reason}. Your progress is saved.`,
    );
    yield* Effect.sleep("60 seconds");
  }

  yield* announce(server, `Restarting now for ${options.reason}; back in a few minutes.`);
  yield* shell.run(server, ["docker", "exec", server.container, "rest-cli", "save"]);
  yield* shell.run(server, ["docker", "exec", server.container, "backup"]);

  if (server.backupCommand !== undefined) {
    yield* onHost(server, server.backupCommand);
  }

  const stop = Effect.gen(function* () {
    yield* compose("stop", service);

    if ((yield* inspect(server, "{{.State.Running}}")) !== "false") {
      return yield* failed(`${server.container} is still running after docker compose stop`);
    }
  });

  // Ready means the container reports healthy, has not restarted since it started, and answers REST calls.
  const waitUntilReady = Effect.gen(function* () {
    yield* compose("up", "-d", service);

    const restartsAtStart = yield* inspect(server, "{{.RestartCount}}");

    const check = Effect.gen(function* () {
      const [status, health, restarts, oom] = (yield* inspect(
        server,
        "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}} {{.RestartCount}} {{.State.OOMKilled}}",
      )).split(" ");

      if (oom === "true" || restarts !== restartsAtStart) {
        return yield* failed(
          `${server.container} ${oom === "true" ? "ran out of memory" : "restarted"} after starting`,
        );
      }

      if (status !== "running" || health !== "healthy") {
        return yield* new NotReady({
          reason: `${server.container} is ${status}${health ? `, ${health}` : ""}`,
        });
      }

      return yield* rest
        .info(server)
        .pipe(Effect.mapError(() => new NotReady({ reason: "REST API not answering yet" })));
    });

    return yield* check.pipe(
      Effect.retry({
        schedule: Schedule.spaced("5 seconds"),
        while: (error) => error instanceof NotReady,
      }),
      Effect.timeoutOrElse({
        duration: "10 minutes",
        orElse: () =>
          Effect.fail(failed(`${server.name} was not healthy within 10 minutes of starting`)),
      }),
      Effect.mapError((error) => (error instanceof NotReady ? failed(error.reason) : error)),
    );
  });

  const verify = Effect.gen(function* () {
    yield* waitUntilReady;
    yield* options.afterStart ?? Effect.void;

    // FPS is low while the world loads, so it is sampled after the server has settled.
    yield* Effect.sleep(options.settle ?? "30 seconds");

    const fps = (yield* rest.metrics(server)).serverfps;

    if (fps < minimumFps) {
      return yield* failed(`The server runs at ${fps} FPS, below ${minimumFps}`);
    }

    return fps;
  });

  const rollback = (reason: string) =>
    Effect.gen(function* () {
      yield* Effect.logWarning(`${reason}; rolling ${server.name} back to ${options.undone}`);
      yield* stop;
      yield* options.undo;
      yield* waitUntilReady;
    }).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.fail(
            failed(
              `${reason}. Rolling back to ${options.undone} also failed: ${error.message || error._tag}`,
            ),
          ),
        onSuccess: () =>
          Effect.fail(
            failed(`${reason}. Rolled back to ${options.undone}; ${server.name} is healthy.`),
          ),
      }),
    );

  yield* stop;

  const fps = yield* options.whileStopped.pipe(
    Effect.andThen(verify),
    Effect.matchEffect({
      onFailure: (error) => rollback(error.message || error._tag),
      onSuccess: Effect.succeed,
    }),
    Effect.onInterrupt(() => Effect.ignore(compose("up", "-d", service))),
  );

  return { fps } satisfies Maintenance;
});
