import { NodeServices } from "@effect/platform-node";
import { RemoteCommandFailed, RemoteShell, Server } from "@palforge/core";
import { decodeOpenPalConfig } from "@palforge/open-pal";
import { Metrics, PalworldRest, Players, ServerInfo } from "@palforge/palworld-rest";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { deployPack, PackDeployFailed, PackManifest, serverImage } from "#src/index.ts";
import type { BuiltPack } from "#src/index.ts";

const canary = new Server({
  name: "canary",
  sshHost: "palworld-canary",
  container: "palworld-server",
  worldGuid: "0123456789ABCDEF0123456789ABCDEF",
  backupCommand: "copy-backups-off-site",
});

const pack = async (): Promise<BuiltPack> => ({
  dir: "/srv/palforge/packs/25247047-0e6531b049ec",
  pak: "/srv/palforge/packs/25247047-0e6531b049ec/OpenPal_P.pak",
  manifest: new PackManifest({
    gameBuildId: "25247047",
    buildHash: "0e6531b049ec",
    toolchain: "palforge-modbuilder:b69b81769b19",
    config: await Effect.runPromise(decodeOpenPalConfig(`{"guildChest":{"enabled":true}}`, "test")),
    pakSha256: "a64e880a",
    assets: [],
  }),
});

interface Host {
  readonly image: string;
  readonly installFails: boolean;
  readonly guardLog: string;
}

const guardedHost: Host = {
  image: serverImage,
  installFails: false,
  guardLog: "[open-pal] OpenPal_P.pak matches game build 25247047",
};

const inspectAnswers = new Map([
  ['{{index .Config.Labels "com.docker.compose.project.working_dir"}}', "/srv/palworld"],
  [
    '{{index .Config.Labels "com.docker.compose.project.config_files"}}',
    "/srv/palworld/compose.yaml",
  ],
  ['{{index .Config.Labels "com.docker.compose.project"}}', "palworld"],
  ['{{index .Config.Labels "com.docker.compose.service"}}', "palworld"],
  [
    '{{range .Mounts}}{{if eq .Destination "/palworld"}}{{.Source}}{{end}}{{end}}',
    "/srv/palworld/data",
  ],
  ["{{.State.Running}}", "false"],
  ["{{.RestartCount}}", "0"],
  ["{{.State.StartedAt}}", "2026-11-02T10:00:00Z"],
]);

// Plays the server's host and records, in order, the steps palctl took.
const fakeHost = (host: Host) => {
  const steps: Array<string> = [];

  const reply = (server: Server, argv: ReadonlyArray<string>) => {
    if (argv[0] === "docker") {
      steps.push(argv.slice(argv.indexOf(canary.container) + 1).join(" "));

      return Effect.succeed("");
    }

    const script = argv[2] ?? "";
    const args = argv.slice(4);

    if (script.startsWith("docker inspect -f")) {
      const format = args[0] ?? "";

      return Effect.succeed(inspectAnswers.get(format) ?? "running healthy 0 false");
    }

    if (script.includes("docker compose")) {
      const command = args.slice(3).join(" ");

      if (command.startsWith("config --images")) {
        return Effect.succeed(`${host.image}\n`);
      }

      steps.push(`compose ${command}`);

      return Effect.succeed("");
    }

    if (script.includes("install -o")) {
      steps.push("install pack");

      return host.installFails
        ? Effect.fail(
            new RemoteCommandFailed({
              host: server.sshHost,
              command: "install",
              exitCode: 1,
              stderr: "disk full",
            }),
          )
        : Effect.succeed("");
    }

    if (script.startsWith("rm -f")) {
      steps.push("remove pack");

      return Effect.succeed("");
    }

    if (script === canary.backupCommand) {
      steps.push("off-site backup");

      return Effect.succeed("");
    }

    if (script.includes("docker logs")) {
      return Effect.succeed(host.guardLog);
    }

    if (script.includes("RepoDigests")) {
      return Effect.succeed("thijsvanloef/palworld-server-docker@sha256:86fc7470\n");
    }

    if (script.includes("docker image inspect")) {
      return Effect.succeed("present\n");
    }

    return Effect.succeed(script.includes("/proc/") ? "1\n" : "");
  };

  // Like the real shell, nothing happens until the returned effect runs.
  const shell = Layer.succeed(
    RemoteShell,
    RemoteShell.of({ run: (server, argv) => Effect.suspend(() => reply(server, argv)) }),
  );

  const rest = Layer.succeed(
    PalworldRest,
    PalworldRest.of({
      info: () =>
        Effect.succeed(
          new ServerInfo({
            version: "v1.0.5.102999",
            servername: "canary",
            description: "",
            worldguid: canary.worldGuid,
          }),
        ),
      players: () => Effect.succeed(new Players({ players: [] })),
      metrics: () =>
        Effect.succeed(
          new Metrics({
            serverfps: 59,
            serverfpsaverage: 59,
            serverframetime: 16.7,
            currentplayernum: 0,
            maxplayernum: 32,
            basecampnum: 3,
            uptime: 40,
            days: 1,
          }),
        ),
    }),
  );

  return { steps, layer: Layer.mergeAll(shell, rest, NodeServices.layer) };
};

const deployOn = async (host: Host) => {
  const fake = fakeHost(host);
  const run = deployPack(canary, Option.some(await pack())).pipe(Effect.provide(fake.layer));

  return { steps: fake.steps, error: await Effect.runPromise(Effect.flip(run)) };
};

describe("deployPack", () => {
  it("refuses a server whose image has no start-time guard, before touching it", async () => {
    const { steps, error } = await deployOn({
      ...guardedHost,
      image: "thijsvanloef/palworld-server-docker:latest",
    });

    expect(error).toBeInstanceOf(PackDeployFailed);
    expect(error.message).toContain(`Set the palworld service's image to ${serverImage}`);
    expect(steps.some((step) => step.startsWith("compose"))).toBe(false);
  });

  it("saves and backs up before stopping, and rolls back to vanilla when installing fails", async () => {
    const { steps, error } = await deployOn({ ...guardedHost, installFails: true });

    expect(error.message).toContain("Rolled back to vanilla; canary is healthy");

    expect(steps).toEqual([
      "rest-cli announce -",
      "rest-cli save",
      "backup",
      "off-site backup",
      "compose stop palworld",
      "install pack",
      "compose stop palworld",
      "remove pack",
      "compose up -d palworld",
    ]);
  });

  it("rolls back to vanilla when the start-time guard refuses the pack", async () => {
    const guardLog =
      "[open-pal] Moved OpenPal_P.pak aside because its SHA-256 does not match its manifest";

    const { steps, error } = await deployOn({ ...guardedHost, guardLog });

    expect(error.message).toContain(`The start-time guard did not accept the pack: ${guardLog}`);
    expect(error.message).toContain("Rolled back to vanilla");
    expect(steps.slice(-4)).toEqual([
      "compose up -d palworld",
      "compose stop palworld",
      "remove pack",
      "compose up -d palworld",
    ]);
  });
});
