import { NodeServices } from "@effect/platform-node";
import { RemoteCommandFailed, RemoteShell, Server } from "@palforge/core";
import { vanillaConfig } from "@palforge/open-pal";
import { Metrics, PalworldRest, Players, ServerInfo } from "@palforge/palworld-rest";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { GameUpdateFailed, publicBuildId, updateAll, updateServer } from "#src/index.ts";

const server = (name: string, canary: boolean) =>
  new Server({
    name,
    sshHost: `palworld-${name}`,
    container: "palworld-server",
    worldGuid: "0123456789ABCDEF0123456789ABCDEF",
    canary,
  });

const canary = server("canary", true);
const main = server("main", false);

// The end of `app_info_print 2394010` from steamcmd on 2026-11-02; the depots also mention "public".
const appInfo = (buildId: string) => `"2394010"
{
	"depots"
	{
		"2394012"
		{
			"manifests"
			{
				"public"
				{
					"gid"		"4383447389214234104"
					"size"		"4688513393"
				}
			}
		}
		"branches"
		{
			"public"
			{
				"buildid"		"${buildId}"
				"timeupdated"		"1789441330"
			}
		}
		"privatebranches"		"1"
	}
}`;

interface Host {
  readonly installed: string;
  readonly latest: string;
  readonly steamFails?: boolean;
}

// Plays every server's host; records the commands each one received.
const fakeHosts = (hosts: ReadonlyMap<string, Host>) => {
  const commands: Array<string> = [];

  const reply = (target: Server, argv: ReadonlyArray<string>) => {
    const host = hosts.get(target.name) ?? { installed: "1", latest: "1" };

    commands.push(`${target.name}: ${argv.join(" ")}`);

    if (argv[0] === "docker" && argv[1] === "exec") {
      return Effect.succeed(`"buildid"\t\t"${host.installed}"`);
    }

    if (argv[0] === "docker" && argv[1] === "run" && argv.includes("+app_info_print")) {
      return host.steamFails === true
        ? Effect.fail(
            new RemoteCommandFailed({
              host: target.sshHost,
              command: "steamcmd",
              exitCode: 1,
              stderr: "timeout",
            }),
          )
        : Effect.succeed(appInfo(host.latest));
    }

    if (argv[0] === "docker" && argv[1] === "inspect") {
      return Effect.succeed("/srv/palworld/data\n");
    }

    // Scripts run through sh or bash: staging, deploy and rollback steps.
    const script = argv[2] ?? "";
    const format = argv[4] ?? "";

    if (script.includes("appmanifest")) {
      return Effect.succeed(`"buildid"\t\t"${host.latest}"`);
    }

    if (script.includes("Pal-LinuxServer.pak")) {
      return Effect.succeed("present\n");
    }

    if (script.startsWith("docker inspect -f")) {
      return Effect.succeed(
        format === "{{.State.Running}}"
          ? "false"
          : format === "{{.RestartCount}}"
            ? "0"
            : format.includes("{{.State.Status}}")
              ? "running healthy 0 false"
              : "",
      );
    }

    return Effect.succeed("");
  };

  const shell = Layer.succeed(
    RemoteShell,
    RemoteShell.of({ run: (target, argv) => Effect.suspend(() => reply(target, argv)) }),
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
            basecampnum: 1,
            uptime: 1,
            days: 1,
          }),
        ),
    }),
  );

  return { commands, layer: Layer.mergeAll(shell, rest, NodeServices.layer) };
};

describe("publicBuildId", () => {
  it("reads the public branch's build, not a depot manifest", () => {
    expect(publicBuildId(appInfo("25247047"))).toEqual(Option.some("25247047"));
    expect(publicBuildId("{}")).toEqual(Option.none());
  });
});

describe("updateServer", () => {
  it("does nothing when the server already runs Steam's latest build", async () => {
    const fake = fakeHosts(new Map([["main", { installed: "25247047", latest: "25247047" }]]));

    const result = await Effect.runPromise(
      updateServer(main, vanillaConfig, { rehearse: false }).pipe(Effect.provide(fake.layer)),
    );

    expect(result).toEqual({ server: "main", from: "25247047", to: "25247047", updated: false });
    expect(fake.commands.some((command) => command.includes("app_update"))).toBe(false);
  });

  it("names the stage of a rehearsed failure and stops there", async () => {
    const fake = fakeHosts(new Map([["main", { installed: "25247047", latest: "25247047" }]]));

    const error = await Effect.runPromise(
      Effect.flip(
        updateServer(main, vanillaConfig, { rehearse: true, failAt: "stage" }).pipe(
          Effect.provide(fake.layer),
        ),
      ),
    );

    expect(error).toBeInstanceOf(GameUpdateFailed);
    expect(error).toMatchObject({ server: "main", stage: "stage", message: "Rehearsed failure" });
    expect(fake.commands.some((command) => command.includes("app_update"))).toBe(false);
  });

  it("injects a rehearsed switch failure only while the server is stopped", async () => {
    const fake = fakeHosts(new Map([["main", { installed: "25247047", latest: "25247047" }]]));

    const error = await Effect.runPromise(
      Effect.flip(
        updateServer(main, vanillaConfig, { rehearse: true, failAt: "switch" }).pipe(
          Effect.provide(fake.layer),
        ),
      ),
    );

    expect(error.stage).toBe("switch");
    expect(error.message).toContain("Rehearsed failure while switching. Rolled back to vanilla");

    const order = fake.commands.map((command) =>
      command.includes("rsync")
        ? "copy"
        : command.includes(" stop palworld") || command.includes("compose")
          ? "compose"
          : "",
    );

    expect(order.indexOf("copy")).toBeGreaterThan(order.indexOf("compose"));
  });

  it("ignores --fail-at outside a rehearsal", async () => {
    const fake = fakeHosts(new Map([["main", { installed: "25247047", latest: "25247047" }]]));

    const result = await Effect.runPromise(
      updateServer(main, vanillaConfig, { rehearse: false, failAt: "detect" }).pipe(
        Effect.provide(fake.layer),
      ),
    );

    expect(result.updated).toBe(false);
  });

  it("reports a detection failure as the detect stage", async () => {
    const fake = fakeHosts(new Map([["main", { installed: "1", latest: "2", steamFails: true }]]));

    const error = await Effect.runPromise(
      Effect.flip(
        updateServer(main, vanillaConfig, { rehearse: false }).pipe(Effect.provide(fake.layer)),
      ),
    );

    expect(error.stage).toBe("detect");
  });
});

describe("updateAll", () => {
  it("stops the rollout when a canary fails, before touching the other servers", async () => {
    const fake = fakeHosts(
      new Map([
        ["canary", { installed: "1", latest: "2", steamFails: true }],
        ["main", { installed: "1", latest: "2" }],
      ]),
    );

    const rollout = [
      { server: main, config: vanillaConfig },
      { server: canary, config: vanillaConfig },
    ];

    const error = await Effect.runPromise(
      Effect.flip(
        updateAll(rollout, "1 second", { rehearse: false }).pipe(Effect.provide(fake.layer)),
      ),
    );

    expect(error).toMatchObject({ server: "canary", stage: "detect" });
    expect(fake.commands.some((command) => command.startsWith("main:"))).toBe(false);
  });

  it("rolls a canary that fails its soak back to vanilla and stops the rollout", async () => {
    const fake = fakeHosts(
      new Map([
        ["canary", { installed: "7", latest: "7" }],
        ["main", { installed: "7", latest: "7" }],
      ]),
    );

    const error = await Effect.runPromise(
      Effect.flip(
        updateAll(
          [
            { server: canary, config: vanillaConfig },
            { server: main, config: vanillaConfig },
          ],
          "1 second",
          { rehearse: true, failAt: "soak", settle: "0 millis" },
        ).pipe(Effect.provide(fake.layer)),
      ),
    );

    expect(error).toMatchObject({ server: "canary", stage: "soak" });
    expect(error.message).toContain("Rolled back to vanilla");
    expect(
      fake.commands.filter((command) => command.startsWith("canary:") && command.includes("rm -f")),
    ).toHaveLength(2);
    expect(fake.commands.some((command) => command.startsWith("main:"))).toBe(false);
  });

  it("updates nothing on servers that are up to date, canaries first", async () => {
    const fake = fakeHosts(
      new Map([
        ["canary", { installed: "7", latest: "7" }],
        ["main", { installed: "7", latest: "7" }],
      ]),
    );

    const results = await Effect.runPromise(
      updateAll(
        [
          { server: main, config: vanillaConfig },
          { server: canary, config: vanillaConfig },
        ],
        "1 second",
        { rehearse: false },
      ).pipe(Effect.provide(fake.layer)),
    );

    expect(results.map((result) => [result.server, result.updated])).toEqual([
      ["canary", false],
      ["main", false],
    ]);
  });
});
