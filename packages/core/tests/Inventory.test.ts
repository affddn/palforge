import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Inventory, InventoryLoadError, Server, UnknownServer } from "#src/index.ts";

const canary = new Server({
  name: "canary",
  sshHost: "palworld-canary",
  container: "palworld-server",
  worldGuid: "0123456789ABCDEF0123456789ABCDEF",
});

const find = (server: string) =>
  Inventory.use((inventory) => inventory.find(server)).pipe(
    Effect.provide(Inventory.layer([canary])),
  );

const serversFrom = (contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* fs.makeTempFileScoped({ suffix: ".json" });

    yield* fs.writeFileString(path, contents);

    return yield* Inventory.use((inventory) => Effect.succeed(inventory.servers)).pipe(
      Effect.provide(Inventory.layerFromFile(path)),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("Inventory", () => {
  it("finds a configured server by name", async () => {
    expect(await Effect.runPromise(find("canary"))).toBe(canary);
  });

  it("fails with UnknownServer for a name that is not configured", async () => {
    const error = await Effect.runPromise(Effect.flip(find("missing")));

    expect(error).toBeInstanceOf(UnknownServer);
    expect(error.server).toBe("missing");
  });

  it("loads servers from the operator's inventory file", async () => {
    const servers = await Effect.runPromise(
      serversFrom(
        `[{"name":"canary","sshHost":"palworld-canary","container":"palworld-server","worldGuid":"0123456789ABCDEF0123456789ABCDEF"}]`,
      ),
    );

    expect(servers.map((server) => server.name)).toEqual(["canary"]);
  });

  it("fails with InventoryLoadError when an entry is missing a field", async () => {
    const error = await Effect.runPromise(
      Effect.flip(serversFrom(`[{"name":"canary","sshHost":"palworld-canary"}]`)),
    );

    expect(error).toBeInstanceOf(InventoryLoadError);
  });

  it("fails with InventoryLoadError when the file does not exist", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Inventory.use((inventory) => Effect.succeed(inventory.servers)).pipe(
          Effect.provide(Inventory.layerFromFile("/nonexistent/palforge/servers.json")),
          Effect.provide(NodeServices.layer),
        ),
      ),
    );

    expect(error).toBeInstanceOf(InventoryLoadError);
    expect(error.source).toBe("/nonexistent/palforge/servers.json");
  });

  it("loads servers from inline JSON such as an environment variable", async () => {
    const servers = await Effect.runPromise(
      Inventory.use((inventory) => Effect.succeed(inventory.servers)).pipe(
        Effect.provide(
          Inventory.layerFromJson(
            `[{"name":"canary","sshHost":"palworld-canary","container":"palworld-server","worldGuid":"0123456789ABCDEF0123456789ABCDEF"}]`,
            "$PALFORGE_SERVERS",
          ),
        ),
      ),
    );

    expect(servers.map((server) => server.name)).toEqual(["canary"]);
  });

  it("names the environment variable when inline JSON is invalid", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Inventory.use((inventory) => Effect.succeed(inventory.servers)).pipe(
          Effect.provide(Inventory.layerFromJson("not json", "$PALFORGE_SERVERS")),
        ),
      ),
    );

    expect(error).toBeInstanceOf(InventoryLoadError);
    expect(error.message).toContain("$PALFORGE_SERVERS");
  });
});
