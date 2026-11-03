import { RemoteCommandFailed, RemoteShell, Server } from "@palforge/core";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { PalworldRest, PalworldRestError } from "#src/index.ts";

const canary = new Server({
  name: "canary",
  sshHost: "palworld-canary",
  container: "palworld-server",
  worldGuid: "0123456789ABCDEF0123456789ABCDEF",
});

// Captured from the canary's rest-cli on 2026-11-02.
const infoOutput = `{
	"version": "v1.0.5.102999",
	"servername": "canary palworld server",
	"description": "test island",
	"worldguid": "0123456789ABCDEF0123456789ABCDEF"
}`;

const metricsOutput = `{
	"currentplayernum": 0,
	"serverfps": 59,
	"serverfpsaverage": 59.290000915527344,
	"serverframetime": 16.748516082763672,
	"days": 2253,
	"maxplayernum": 32,
	"basecampnum": 3,
	"uptime": 27
}`;

const playersOutput = `{"players":[{"name":"Ayla","accountName":"ayla_ps5","playerId":"1A2B3C4D","userId":"ps5_1","ip":"203.0.113.7","ping":42.5,"location_x":-12345.6,"location_y":67890.1,"level":53,"building_count":120}]}`;

// What the canary (v1.0.5.102999) sent on 2026-11-02 with a PS5 player online; the address is replaced.
const playersOutputV105 = `{
	"players": [
		{
			"name": "Ayla",
			"accountName": "ayla_ps5",
			"playerId": "1A2B3C4D000000000000000000000000",
			"userId": "ps5_1234567890123456789",
			"iP": "203.0.113.7",
			"ping": 50.142856597900391,
			"location_x": 7011.89013671875,
			"location_y": 128162.6484375,
			"level": 54
		}
	]
}`;

const shellReplying = (outputs: ReadonlyMap<string, string>) =>
  Layer.succeed(
    RemoteShell,
    RemoteShell.of({
      run: (server, argv) => {
        const command = argv.join(" ");
        const output = outputs.get(command);

        return output === undefined
          ? Effect.fail(
              new RemoteCommandFailed({
                host: server.sshHost,
                command,
                exitCode: 1,
                stderr: "no such command",
              }),
            )
          : Effect.succeed(output);
      },
    }),
  );

const withShell = (outputs: ReadonlyMap<string, string>) =>
  PalworldRest.layer.pipe(Layer.provide(shellReplying(outputs)));

const restCli = (endpoint: string) => `docker exec palworld-server rest-cli ${endpoint}`;

describe("PalworldRest", () => {
  it("decodes server info and metrics from rest-cli output", async () => {
    const outputs = new Map([
      [restCli("info"), infoOutput],
      [restCli("metrics"), metricsOutput],
    ]);

    const [info, metrics] = await Effect.runPromise(
      PalworldRest.use((rest) => Effect.all([rest.info(canary), rest.metrics(canary)])).pipe(
        Effect.provide(withShell(outputs)),
      ),
    );

    expect(info.version).toBe("v1.0.5.102999");
    expect(info.worldguid).toBe(canary.worldGuid);
    expect(metrics.serverfps).toBe(59);
    expect(metrics.basecampnum).toBe(3);
  });

  it("decodes the documented player fields", async () => {
    const players = await Effect.runPromise(
      PalworldRest.use((rest) => rest.players(canary)).pipe(
        Effect.provide(withShell(new Map([[restCli("players"), playersOutput]]))),
      ),
    );

    expect(players.players).toHaveLength(1);
    expect(players.players[0]?.level).toBe(53);
  });

  it("decodes the players a v1.0.5 server sends, with iP and without building_count", async () => {
    const players = await Effect.runPromise(
      PalworldRest.use((rest) => rest.players(canary)).pipe(
        Effect.provide(withShell(new Map([[restCli("players"), playersOutputV105]]))),
      ),
    );

    expect(players.players[0]).toMatchObject({
      name: "Ayla",
      userId: "ps5_1234567890123456789",
      level: 54,
    });
    expect(players.players[0]?.building_count).toBeUndefined();
  });

  it("fails with PalworldRestError when the output does not match the schema", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        PalworldRest.use((rest) => rest.metrics(canary)).pipe(
          Effect.provide(withShell(new Map([[restCli("metrics"), `{"serverfps":"fast"}`]]))),
        ),
      ),
    );

    expect(error).toBeInstanceOf(PalworldRestError);
    expect(error.endpoint).toBe("metrics");
  });

  it("fails with PalworldRestError when the remote command fails", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        PalworldRest.use((rest) => rest.info(canary)).pipe(Effect.provide(withShell(new Map()))),
      ),
    );

    expect(error).toBeInstanceOf(PalworldRestError);
    expect(error.cause).toBeInstanceOf(RemoteCommandFailed);
  });
});
