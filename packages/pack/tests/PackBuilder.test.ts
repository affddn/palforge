import { NodeServices } from "@effect/platform-node";
import { RemoteShell, Server } from "@palforge/core";
import { decodeOpenPalConfig } from "@palforge/open-pal";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { buildPack, PackBuildFailed } from "#src/index.ts";

const canary = new Server({
  name: "canary",
  sshHost: "palworld-canary",
  container: "palworld-server",
  worldGuid: "0123456789ABCDEF0123456789ABCDEF",
});

const intProperty = (name: string, value: number) => ({
  $type: "UAssetAPI.PropertyTypes.Objects.IntPropertyData, UAssetAPI",
  Name: name,
  Value: value,
});

const vanillaGameSettings = JSON.stringify({
  Exports: [
    { ObjectName: "BP_PalGameSetting_C", Data: [] },
    {
      ObjectName: "Default__BP_PalGameSetting_C",
      Data: [intProperty("GuildCharacterMaxLevel", 30), intProperty("GuildChestSlotNum", 54)],
    },
  ],
});

const slotChange = { path: ["Exports", 1, "Data", 1, "Value"], before: 54, after: 444 };

interface Upload {
  readonly path: string;
  readonly content: string;
}

// Plays the server's host: answers each script by what it does and records what palctl uploads.
const fakeHost = (changes: ReadonlyArray<typeof slotChange>) => {
  const scripts: Array<string> = [];
  const commandLines: Array<string> = [];
  const uploads: Array<Upload> = [];

  const reply = (argv: ReadonlyArray<string>, input: string | undefined) => {
    if (argv[0] === "docker" && argv[1] === "exec") {
      return `"buildid"\t\t"25247047"`;
    }

    if (argv[0] === "docker" && argv[1] === "inspect") {
      return "/srv/palworld/data\n";
    }

    const script = argv[2] ?? "";
    const path = argv[4] ?? "";

    scripts.push(script);
    commandLines.push(argv.join(" "));

    if (input !== undefined) {
      uploads.push({ path, content: input });

      return "";
    }

    if (script.startsWith("test -f")) {
      return "cached\n";
    }

    if (script.includes("docker image inspect")) {
      return "present\n";
    }

    if (script.includes("docker inspect")) {
      return "/srv/palworld/data\n";
    }

    if (script.startsWith("cat ") && path.includes("/json/vanilla/")) {
      return vanillaGameSettings;
    }

    if (script.startsWith("cat ") && path.includes("/changes/")) {
      return JSON.stringify(changes);
    }

    // The toolchain scripts travel as arguments to the docker run wrapper.
    return argv.includes("sh") && argv.some((arg) => arg.includes("repak pack"))
      ? "a64e880a  OpenPal_P.pak\n"
      : "";
  };

  const layer = Layer.succeed(
    RemoteShell,
    RemoteShell.of({ run: (_server, argv, input) => Effect.succeed(reply(argv, input)) }),
  );

  return { layer, scripts, commandLines, uploads };
};

const build = (configJson: string, changes: ReadonlyArray<typeof slotChange>) => {
  const host = fakeHost(changes);

  const run = decodeOpenPalConfig(configJson, "test").pipe(
    Effect.flatMap((config) => buildPack(canary, config)),
    Effect.provide(host.layer),
    Effect.provide(NodeServices.layer),
  );

  return { host, run };
};

const guildChest444 = `{"guildChest":{"enabled":true,"slots":444}}`;

describe("buildPack", () => {
  it("builds nothing and touches no server when every feature is off", async () => {
    const { host, run } = build("{}", []);

    expect(Option.isNone(await Effect.runPromise(run))).toBe(true);
    expect(host.scripts).toEqual([]);
  });

  it("sends the recipe's edits and records them in the manifest", async () => {
    const { host, run } = build(guildChest444, [slotChange]);
    const built = await Effect.runPromise(run);

    if (Option.isNone(built)) {
      throw new Error("expected a pack");
    }

    expect(built.value.pak).toMatch(
      /^\/srv\/palforge\/packs\/25247047-[0-9a-f]{12}\/OpenPal_P\.pak$/u,
    );
    expect(built.value.manifest.pakSha256).toBe("a64e880a");

    expect(built.value.manifest.assets).toEqual([
      {
        asset: "Pal/Content/Pal/Blueprint/System/BP_PalGameSetting",
        features: ["guildChest"],
        edits: [
          {
            label: "Default__BP_PalGameSetting_C.GuildChestSlotNum",
            kind: "int",
            from: 54,
            to: 444,
          },
        ],
      },
    ]);

    const edits = host.uploads.find((upload) => upload.path.includes("/edits/"));

    expect(JSON.parse(edits?.content ?? "null")).toEqual([
      { path: ["Exports", 1, "Data", 1, "Value"], value: 444 },
    ]);

    expect(host.uploads.some((upload) => upload.path.endsWith("/manifest.json"))).toBe(true);
  });

  it("rejects a pak whose assets changed outside the recipe", async () => {
    const outside = { path: ["Exports", 1, "Data", 0, "Value"], before: 30, after: 99 };
    const { host, run } = build(guildChest444, [slotChange, outside]);
    const error = await Effect.runPromise(Effect.flip(run));

    expect(error).toBeInstanceOf(PackBuildFailed);
    expect(error.message).toContain("changed outside the recipe: Exports.1.Data.0.Value 30 -> 99");
    expect(host.uploads.some((upload) => upload.path.endsWith("/manifest.json"))).toBe(false);
    expect(host.scripts).toContain('rm -f "$1"');
  });

  it("rejects a pak that is missing a recipe edit", async () => {
    const error = await Effect.runPromise(Effect.flip(build(guildChest444, []).run));

    expect(error.message).toContain(
      "not applied: Default__BP_PalGameSetting_C.GuildChestSlotNum -> 444",
    );
  });

  it("packs with a single repak thread, since parallel packing orders entries differently each run", async () => {
    const { host, run } = build(guildChest444, [slotChange]);

    await Effect.runPromise(run);

    expect(host.commandLines.some((line) => line.includes("RAYON_NUM_THREADS=1 repak pack"))).toBe(
      true,
    );
  });

  it("names the same build directory for the same game build and config", async () => {
    const first = await Effect.runPromise(build(guildChest444, [slotChange]).run);
    const second = await Effect.runPromise(build(guildChest444, [slotChange]).run);

    const other = await Effect.runPromise(
      build(`{"guildChest":{"enabled":true,"slots":200}}`, [{ ...slotChange, after: 200 }]).run,
    );

    expect(Option.map(first, (pack) => pack.dir)).toEqual(Option.map(second, (pack) => pack.dir));
    expect(Option.map(first, (pack) => pack.dir)).not.toEqual(
      Option.map(other, (pack) => pack.dir),
    );
  });
});
