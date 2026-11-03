import { NodeServices } from "@effect/platform-node";
import { RemoteCommandFailed, RemoteShell, Server } from "@palforge/core";
import { decodeOpenPalConfig, decodeOpenPalEvents, vanillaConfig } from "@palforge/open-pal";
import { Metrics, PalworldRest, Players, ServerInfo } from "@palforge/palworld-rest";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { PackManifest, syncEvents } from "#src/index.ts";

const canary = new Server({
  name: "canary",
  sshHost: "palworld-canary",
  container: "palworld-server",
  worldGuid: "0123456789ABCDEF0123456789ABCDEF",
});

const eggWeekend = Effect.runSync(
  decodeOpenPalEvents(
    JSON.stringify({
      events: {
        "egg-weekend": {
          start: "2026-11-07T00:00:00Z",
          end: "2026-11-09T00:00:00Z",
          message: "Egg weekend: eggs come four times as fast",
          features: {},
        },
      },
    }),
    "test",
  ),
);

const installedManifest = JSON.stringify(
  Schema.encodeSync(PackManifest)(
    new PackManifest({
      gameBuildId: "25247047",
      buildHash: "0e6531b049ec",
      toolchain: "palforge-modbuilder:b69b81769b19",
      config: Effect.runSync(decodeOpenPalConfig(`{"breeding":{"enabled":true}}`, "test")),
      pakSha256: "a64e880a",
      assets: [],
    }),
  ),
);

const inspectAnswers = new Map([
  ['{{index .Config.Labels "com.docker.compose.project.working_dir"}}', "/srv/palworld"],
  [
    '{{index .Config.Labels "com.docker.compose.project.config_files"}}',
    "/srv/palworld/compose.yaml",
  ],
  ['{{index .Config.Labels "com.docker.compose.project"}}', "palworld"],
  ['{{index .Config.Labels "com.docker.compose.service"}}', "palworld"],
  ["{{.State.Running}}", "false"],
  ["{{.RestartCount}}", "0"],
]);

interface Host {
  manifest: string;
  removeFails: boolean;
  state: string | undefined;
}

// Plays the canary's host, keeps `<workDir>/events/canary.json` between runs, and records what players were
// told and whether the server restarted.
const fakeHost = (host: Host) => {
  const told: Array<string> = [];
  const steps: Array<string> = [];

  const reply = (server: Server, argv: ReadonlyArray<string>, input?: string) => {
    const script = argv[2] ?? "";
    const args = argv.slice(4);

    if (argv.includes("announce")) {
      told.push(
        Schema.decodeUnknownSync(Schema.Struct({ message: Schema.String }))(
          JSON.parse(input ?? "{}"),
        ).message,
      );

      return Effect.succeed("");
    }

    if (argv[0] === "docker" && argv[1] === "inspect") {
      return Effect.succeed("/srv/palworld/data\n");
    }

    if (argv[0] === "docker") {
      return Effect.succeed("");
    }

    if (script.startsWith('cat "$1" 2>/dev/null')) {
      return Effect.succeed(host.state ?? '{"active":[],"failedConfig":null}');
    }

    if (script.includes('cat > "$1"')) {
      host.state = input;

      return Effect.succeed("");
    }

    if (script.startsWith("if [ -f")) {
      return Effect.succeed(host.manifest);
    }

    if (script.startsWith("docker inspect -f")) {
      return Effect.succeed(inspectAnswers.get(args[0] ?? "") ?? "running healthy 0 false");
    }

    if (script.includes("docker compose")) {
      const command = args.slice(3).join(" ");

      if (!command.startsWith("config")) {
        steps.push(`compose ${command}`);
      }

      return Effect.succeed("");
    }

    if (script.startsWith("rm -f")) {
      steps.push("remove pack");

      if (host.removeFails) {
        return Effect.fail(
          new RemoteCommandFailed({
            host: server.sshHost,
            command: "rm",
            exitCode: 1,
            stderr: "read-only file system",
          }),
        );
      }

      host.manifest = "";
    }

    return Effect.succeed("");
  };

  const shell = Layer.succeed(
    RemoteShell,
    RemoteShell.of({
      run: (server, argv, input) => Effect.suspend(() => reply(server, argv, input)),
    }),
  );

  const rest = Layer.succeed(
    PalworldRest,
    PalworldRest.of({
      info: () =>
        Effect.succeed(
          new ServerInfo({ version: "v1", servername: "", description: "", worldguid: "" }),
        ),
      players: () => Effect.succeed(new Players({ players: [] })),
      metrics: () =>
        Effect.succeed(
          new Metrics({
            serverfps: 59,
            serverfpsaverage: 59,
            serverframetime: 16,
            currentplayernum: 0,
            maxplayernum: 32,
            basecampnum: 3,
            uptime: 40,
            days: 1,
          }),
        ),
    }),
  );

  const sync = (active: typeof eggWeekend) =>
    syncEvents(canary, vanillaConfig, active, { settle: "0 millis" }).pipe(
      Effect.provide(Layer.mergeAll(shell, rest, NodeServices.layer)),
    );

  return { told, steps, sync };
};

describe("syncEvents", () => {
  it("restarts with the settings after the event and tells players the event ended", async () => {
    const fake = fakeHost({
      manifest: installedManifest,
      removeFails: false,
      state: '{"active":["egg-weekend"],"failedConfig":null}',
    });

    const result = await Effect.runPromise(fake.sync([]));

    expect(result).toMatchObject({ deployed: true, started: [], ended: ["egg-weekend"] });
    expect(fake.steps).toEqual(["compose stop palworld", "remove pack", "compose up -d palworld"]);
    expect(fake.told[0]).toContain("for the end of the egg-weekend event");
    expect(fake.told.at(-1)).toBe("The egg-weekend event has ended.");
  });

  it("announces an event without a restart when the pack already matches", async () => {
    const fake = fakeHost({ manifest: "", removeFails: false, state: undefined });
    const result = await Effect.runPromise(fake.sync(eggWeekend));

    expect(result).toMatchObject({ deployed: false, started: ["egg-weekend"] });
    expect(fake.steps).toEqual([]);
    expect(fake.told).toEqual(["Egg weekend: eggs come four times as fast"]);

    const again = await Effect.runPromise(fake.sync(eggWeekend));

    expect(again).toMatchObject({ deployed: false, started: [], ended: [] });
    expect(fake.told).toHaveLength(1);
  });

  it("does not retry settings whose deploy failed until they change", async () => {
    const fake = fakeHost({ manifest: installedManifest, removeFails: true, state: undefined });

    await Effect.runPromise(Effect.flip(fake.sync([])));

    const restarts = fake.steps.filter((step) => step === "compose stop palworld").length;
    const held = await Effect.runPromise(fake.sync([]));

    expect(held.held).toContain("the last deploy of these settings failed");
    expect(fake.steps.filter((step) => step === "compose stop palworld")).toHaveLength(restarts);
  });
});
