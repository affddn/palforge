import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Server } from "./Server.ts";

export class RemoteShellError extends Schema.TaggedError<RemoteShellError>()("RemoteShellError", {
  host: Schema.String,
  command: Schema.String,
  cause: Schema.Defect(),
}) {}

export class RemoteCommandFailed extends Schema.TaggedError<RemoteCommandFailed>()(
  "RemoteCommandFailed",
  {
    host: Schema.String,
    command: Schema.String,
    exitCode: Schema.Int,
    stderr: Schema.String,
  },
) {}

// ssh joins its trailing arguments into one remote shell command, so every argument is single-quoted.
const shellQuote = (argument: string) => `'${argument.replaceAll("'", `'\\''`)}'`;

export class RemoteShell extends Context.Service<
  RemoteShell,
  {
    // `input` is written to the remote command's stdin, for data too large for an argument.
    run(
      server: Server,
      argv: ReadonlyArray<string>,
      input?: string,
    ): Effect.Effect<string, RemoteShellError | RemoteCommandFailed>;
  }
>()("@palforge/core/RemoteShell") {
  static readonly layerSsh = Layer.effect(
    RemoteShell,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const run = Effect.fn("RemoteShell.run")(function* (
        server: Server,
        argv: ReadonlyArray<string>,
        input?: string,
      ) {
        const command = argv.map(shellQuote).join(" ");
        const sshArgs = ["-o", "BatchMode=yes", server.sshHost, "--", command];

        const [stdout, stderr, exitCode] = yield* Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            input === undefined
              ? ChildProcess.make("ssh", sshArgs)
              : ChildProcess.make("ssh", sshArgs, {
                  stdin: Stream.make(new TextEncoder().encode(input)),
                }),
          );

          return yield* Effect.all(
            [
              handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
              handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          );
        }).pipe(
          Effect.scoped,
          Effect.mapError(
            (cause) => new RemoteShellError({ host: server.sshHost, command, cause }),
          ),
        );

        if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
          return yield* new RemoteCommandFailed({
            host: server.sshHost,
            command,
            exitCode,
            stderr,
          });
        }

        return stdout;
      });

      return RemoteShell.of({ run });
    }),
  );
}
