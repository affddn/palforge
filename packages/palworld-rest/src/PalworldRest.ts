import { RemoteShell, type Server } from "@palforge/core";
import { Context, Effect, Layer, Schema } from "effect";
import { Metrics, Players, ServerInfo } from "./schemas.ts";

export class PalworldRestError extends Schema.TaggedError<PalworldRestError>()(
  "PalworldRestError",
  {
    server: Schema.String,
    endpoint: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class PalworldRest extends Context.Service<
  PalworldRest,
  {
    info(server: Server): Effect.Effect<ServerInfo, PalworldRestError>;
    players(server: Server): Effect.Effect<Players, PalworldRestError>;
    metrics(server: Server): Effect.Effect<Metrics, PalworldRestError>;
  }
>()("@palforge/palworld-rest/PalworldRest") {
  // The REST API listens on 127.0.0.1 inside each VPS, so it is reached through the
  // container's rest-cli over SSH instead of an exposed port.
  static readonly layer = Layer.effect(
    PalworldRest,
    Effect.gen(function* () {
      const shell = yield* RemoteShell;

      const call = <A>(server: Server, endpoint: string, response: Schema.Codec<A, string>) =>
        shell.run(server, ["docker", "exec", server.container, "rest-cli", endpoint]).pipe(
          Effect.flatMap(Schema.decodeEffect(response)),
          Effect.mapError(
            (cause) => new PalworldRestError({ server: server.name, endpoint, cause }),
          ),
        );

      return PalworldRest.of({
        info: (server) => call(server, "info", Schema.fromJsonString(ServerInfo)),
        players: (server) => call(server, "players", Schema.fromJsonString(Players)),
        metrics: (server) => call(server, "metrics", Schema.fromJsonString(Metrics)),
      });
    }),
  );
}
