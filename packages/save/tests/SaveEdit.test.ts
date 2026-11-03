import { NodeServices } from "@effect/platform-node";
import { RemoteCommandFailed, RemoteShell, Server } from "@palforge/core";
import { Metrics, PalworldRest, Players, ServerInfo } from "@palforge/palworld-rest";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { decodeSavePlan, editSave, SaveEditFailed } from "#src/index.ts";
import type { SavePlan } from "#src/index.ts";

const canary = new Server({
  name: "canary",
  sshHost: "palworld-canary",
  container: "palworld-server",
  worldGuid: "0123456789ABCDEF0123456789ABCDEF",
});

const decode = (operations: ReadonlyArray<unknown>) =>
  Effect.runSync(decodeSavePlan(JSON.stringify({ operations }), "plan.json"));

const plan = decode([{ op: "giveItem", player: "Ayla", item: "Money", count: 10 }]);

const container = "6e1f0c3a-0000-4000-8000-000000000001";

const report = JSON.stringify({
  changes: ["Gave Ayla 10 Money"],
  files: ["Level.sav"],
  expect: [],
});

interface Host {
  // savetool's stderr when it refuses, by its command.
  readonly refuses: ReadonlyMap<string, string>;
  // Paths on the host that cannot be read.
  readonly unreadable?: ReadonlySet<string>;
}

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

// Plays the canary's host and records, in order, the steps palctl took.
const fakeHost = (host: Host) => {
  const steps: Array<string> = [];
  const uploads = new Map<string, string>();
  let runs = 0;

  const reply = (server: Server, argv: ReadonlyArray<string>, input?: string) => {
    const script = argv[2] ?? "";
    const args = argv.slice(4);

    if (argv[0] === "docker" && argv[1] === "inspect") {
      return Effect.succeed("/srv/palworld/data\n");
    }

    if (argv[0] === "docker") {
      steps.push(argv.slice(argv.indexOf(canary.container) + 1).join(" "));

      return Effect.succeed("");
    }

    if (script.startsWith("docker inspect -f")) {
      return Effect.succeed(inspectAnswers.get(args[0] ?? "") ?? "running healthy 0 false");
    }

    if (script.includes("docker compose")) {
      steps.push(`compose ${args.slice(3).join(" ")}`);

      return Effect.succeed("");
    }

    if (script.includes("docker image inspect")) {
      return Effect.succeed("present\n");
    }

    if (script.includes("mktemp")) {
      runs += 1;

      return Effect.succeed(`/srv/palforge/saves/run${runs}\n`);
    }

    if (script.includes("rest-cli save")) {
      steps.push("save and wait for it");

      return Effect.succeed("saved\n");
    }

    if (script.includes("cp -p")) {
      steps.push(`copy world to ${args[1]?.split("/").slice(-2).join("/")}`);

      return Effect.succeed("");
    }

    if (script.startsWith("cat >")) {
      uploads.set(args[0] ?? "", input ?? "");

      return Effect.succeed("");
    }

    if (script.includes("tar -xzOf")) {
      const [source = "", into = "", world = ""] = args;

      if (host.unreadable?.has(source) === true) {
        return Effect.fail(
          new RemoteCommandFailed({
            host: server.sshHost,
            command: "sh",
            exitCode: 2,
            stderr: `tar: */${world}/Level.sav: Not found in archive`,
          }),
        );
      }

      steps.push(`stage ${source} in ${into.split("/").slice(-3).join("/")} for ${world}`);

      return Effect.succeed("");
    }

    if (script.includes("docker run")) {
      const command = args[2] ?? "";
      const refusal = host.refuses.get(command);

      steps.push(`savetool ${command}`);

      return refusal === undefined
        ? Effect.succeed(command === "apply" ? report : '{"verified": 0}')
        : Effect.fail(
            new RemoteCommandFailed({
              host: server.sshHost,
              command: "savetool",
              exitCode: 1,
              stderr: refusal,
            }),
          );
    }

    if (script.includes('>> "$dir/installed"')) {
      steps.push(`install ${args.slice(2).join(" ")}`);

      return Effect.succeed("");
    }

    if (script.includes('< "$dir/installed"')) {
      steps.push("put back the originals");

      return Effect.succeed("");
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

  return { steps, uploads, layer: Layer.mergeAll(shell, rest, NodeServices.layer) };
};

const editOn = (host: Host, edit: SavePlan = plan) => {
  const fake = fakeHost(host);
  const run = editSave(canary, edit, { settle: "0 millis" }).pipe(Effect.provide(fake.layer));

  return { steps: fake.steps, uploads: fake.uploads, run };
};

describe("editSave", () => {
  it("tries the plan on a copy, edits the stopped saves, and checks the edit survives a save", async () => {
    const { steps, run } = editOn({ refuses: new Map() });
    const edit = await Effect.runPromise(run);

    expect(edit.report.changes).toEqual(["Gave Ayla 10 Money"]);
    expect(edit.dir).toBe("/srv/palforge/saves/run2");

    expect(steps).toEqual([
      "save and wait for it",
      "copy world to run1/original",
      "savetool apply",
      "rest-cli announce -",
      "rest-cli save",
      "backup",
      "compose stop palworld",
      "copy world to run2/original",
      "savetool apply",
      "install Level.sav",
      "compose up -d palworld",
      "save and wait for it",
      "copy world to run2/resaved",
      "savetool verify",
    ]);
  });

  it("refuses a plan that does not apply before announcing anything", async () => {
    const { steps, run } = editOn({
      refuses: new Map([["apply", "no player with a save file is called Ayla"]]),
    });

    const error = await Effect.runPromise(Effect.flip(run));

    expect(error).toBeInstanceOf(SaveEditFailed);
    expect(error.message).toBe("no player with a save file is called Ayla");
    expect(steps.some((step) => step.includes("announce") || step.startsWith("compose"))).toBe(
      false,
    );
  });

  it("puts back the original saves when the edit is gone after the server saves", async () => {
    const { steps, run } = editOn({
      refuses: new Map([["verify", "Money is no longer in item container a0c124b2"]]),
    });

    const error = await Effect.runPromise(Effect.flip(run));

    expect(error.message).toContain("Money is no longer in item container a0c124b2");
    expect(error.message).toContain("Rolled back to the saves from before the edit");

    expect(steps.slice(-4)).toEqual([
      "savetool verify",
      "compose stop palworld",
      "put back the originals",
      "compose up -d palworld",
    ]);
  });

  it("copies each older save a plan restores from into the run and points the plan at the copy", async () => {
    const restore = decode([
      { op: "restoreContainer", container, from: "/srv/backups/world-0600.tar.gz" },
      { op: "restoreContainer", container, from: "/srv/saves/run0/original/Level.sav" },
      { op: "restoreContainer", container, from: "/srv/backups/world-0600.tar.gz" },
    ]);

    const { steps, uploads, run } = editOn({ refuses: new Map() }, restore);

    await Effect.runPromise(run);

    expect(steps.filter((step) => step.startsWith("stage"))).toEqual([
      `stage /srv/backups/world-0600.tar.gz in run1/sources/0 for ${canary.worldGuid}`,
      `stage /srv/saves/run0/original/Level.sav in run1/sources/1 for ${canary.worldGuid}`,
      `stage /srv/backups/world-0600.tar.gz in run2/sources/0 for ${canary.worldGuid}`,
      `stage /srv/saves/run0/original/Level.sav in run2/sources/1 for ${canary.worldGuid}`,
    ]);

    const staged = JSON.parse(uploads.get("/srv/palforge/saves/run2/plan.json") ?? "{}");

    expect(staged.operations.map((operation: { from: string }) => operation.from)).toEqual([
      "/edit/sources/0/Level.sav",
      "/edit/sources/1/Level.sav",
      "/edit/sources/0/Level.sav",
    ]);
  });

  it("refuses an older save it cannot read before announcing anything", async () => {
    const { steps, run } = editOn(
      { refuses: new Map(), unreadable: new Set(["/srv/backups/world-0600.tar.gz"]) },
      decode([{ op: "restoreContainer", container, from: "/srv/backups/world-0600.tar.gz" }]),
    );

    const error = await Effect.runPromise(Effect.flip(run));

    expect(error).toBeInstanceOf(SaveEditFailed);
    expect(error.message).toContain("Cannot read /srv/backups/world-0600.tar.gz");
    expect(steps.some((step) => step.includes("announce") || step.startsWith("compose"))).toBe(
      false,
    );
  });
});
