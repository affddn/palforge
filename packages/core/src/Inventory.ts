import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { Server } from "./Server.ts";

export class UnknownServer extends Schema.TaggedError<UnknownServer>()("UnknownServer", {
  server: Schema.String,
  message: Schema.String,
}) {}

export class InventoryLoadError extends Schema.TaggedError<InventoryLoadError>()(
  "InventoryLoadError",
  {
    source: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const InventoryJson = Schema.fromJsonString(Schema.Array(Server));

const loadError = (source: string, cause: Error) =>
  new InventoryLoadError({
    source,
    message: `Could not load the server inventory from ${source}: ${cause.message}`,
    cause,
  });

export class Inventory extends Context.Service<
  Inventory,
  {
    readonly servers: ReadonlyArray<Server>;
    find(server: string): Effect.Effect<Server, UnknownServer>;
  }
>()("@palforge/core/Inventory") {
  static readonly layer = (servers: ReadonlyArray<Server>) =>
    Layer.succeed(
      Inventory,
      Inventory.of({
        servers,
        find: (server) => {
          const match = servers.find((candidate) => candidate.name === server);

          return match === undefined
            ? Effect.fail(
                new UnknownServer({
                  server,
                  message: `No server named "${server}". Configured: ${servers.map((candidate) => candidate.name).join(", ")}`,
                }),
              )
            : Effect.succeed(match);
        },
      }),
    );

  // `source` names where the JSON came from (a file path or an environment variable) for error messages.
  static readonly layerFromJson = (json: string, source: string) =>
    Layer.unwrap(
      Schema.decodeEffect(InventoryJson)(json).pipe(
        Effect.map(Inventory.layer),
        Effect.mapError((cause) => loadError(source, cause)),
      ),
    );

  static readonly layerFromFile = (path: string) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        return yield* fs.readFileString(path);
      }).pipe(
        Effect.mapError((cause) => loadError(path, cause)),
        Effect.map((json) => Inventory.layerFromJson(json, path)),
      ),
    );
}
