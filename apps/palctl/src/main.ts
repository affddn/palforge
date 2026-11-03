import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Inventory, RemoteShell } from "@palforge/core";
import { dumpMappings } from "@palforge/mappings";
import {
  decodeOpenPalConfig,
  decodeOpenPalEvents,
  features,
  isActive,
  readOpenPalJson,
} from "@palforge/open-pal";
import { buildPack, deployPack, syncEvents, updateAll, updateStages } from "@palforge/pack";
import { PalworldRest } from "@palforge/palworld-rest";
import { decodeSavePlan, editSave, previewEdit, setPartyLive, showPlayer } from "@palforge/save";
import type { SavedPal } from "@palforge/save";
import { readPakIndex } from "@palforge/unreal-pak";
import { Config, Console, DateTime, Effect, FileSystem, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { gamePakPath, remotePak } from "#src/GamePak.ts";
import packageJson from "#package.json" with { type: "json" };

const configPath = (file: string) =>
  Config.String("XDG_CONFIG_HOME").pipe(
    Config.map((dir) => `${dir}/palforge/${file}`),
    Config.orElse(() =>
      Config.String("HOME").pipe(Config.map((home) => `${home}/.config/palforge/${file}`)),
    ),
  );

const inventoryFile = Config.String("PALFORGE_SERVERS_FILE").pipe(
  Config.orElse(() => configPath("servers.json")),
);

const inventoryFromEnvironment = Config.String("PALFORGE_SERVERS").pipe(
  Config.map((json) => Inventory.layerFromJson(json, "$PALFORGE_SERVERS")),
  Config.orElse(() => inventoryFile.pipe(Config.map(Inventory.layerFromFile))),
);

const palctl = Command.make("palctl").pipe(
  Command.withDescription("Operate Palworld dedicated servers"),
  Command.withSharedFlags({
    servers: Flag.String("servers").pipe(
      Flag.withDescription(
        "Server inventory JSON file. Without it: $PALFORGE_SERVERS (inline JSON), $PALFORGE_SERVERS_FILE, then ~/.config/palforge/servers.json",
      ),
      Flag.optional,
    ),
  }),
);

const serverArgument = Argument.String("server").pipe(
  Argument.withDescription("Server name from the inventory"),
);

const inventoryLayer = Effect.gen(function* () {
  const { servers } = yield* palctl;

  return Option.isSome(servers)
    ? Inventory.layerFromFile(servers.value)
    : yield* inventoryFromEnvironment;
});

const findServer = Effect.fn("findServer")(function* (server: string) {
  return yield* Inventory.use((loaded) => loaded.find(server)).pipe(
    Effect.provide(yield* inventoryLayer),
  );
});

const allServers = Effect.gen(function* () {
  return yield* Inventory.use((loaded) => Effect.succeed(loaded.servers)).pipe(
    Effect.provide(yield* inventoryLayer),
  );
});

const status = Command.make(
  "status",
  { server: serverArgument },
  Effect.fn(function* ({ server }) {
    const target = yield* findServer(server);
    const rest = yield* PalworldRest;

    const [info, metrics, players] = yield* Effect.all(
      [rest.info(target), rest.metrics(target), rest.players(target)],
      { concurrency: "unbounded" },
    );

    yield* Console.log(`${info.servername} (${target.name}) ${info.version}`);
    yield* Console.log(
      `players ${metrics.currentplayernum}/${metrics.maxplayernum}  fps ${metrics.serverfps}  bases ${metrics.basecampnum}  uptime ${metrics.uptime}s`,
    );

    for (const player of players.players) {
      yield* Console.log(
        `  ${player.name}  lv ${player.level}  ping ${Math.round(player.ping)} ms`,
      );
    }
  }),
).pipe(Command.withDescription("Show a server's version, metrics and online players"));

const assets = Command.make(
  "assets",
  {
    server: serverArgument,
    match: Flag.String("match").pipe(
      Flag.withDescription("Only list asset paths containing this text (case-insensitive)"),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ server, match }) {
    const target = yield* findServer(server);
    const index = yield* readPakIndex(yield* remotePak(target, gamePakPath));

    const listed = Option.match(match, {
      onNone: () => index.entries,
      onSome: (text) =>
        index.entries.filter((entry) => entry.path.toLowerCase().includes(text.toLowerCase())),
    });

    for (const entry of listed) {
      yield* Console.log(
        `${entry.compression.padEnd(6)} ${String(entry.uncompressedSize).padStart(10)}  ${entry.path}`,
      );
    }

    yield* Console.log(
      `${listed.length} of ${index.entries.length} assets in ${gamePakPath} (pak v${index.footer.version}, mount ${index.mountPoint})`,
    );
  }),
).pipe(
  Command.withDescription("List the game's packaged assets on a server with their compression"),
);

const mappings = Command.make(
  "mappings",
  { server: serverArgument },
  Effect.fn(function* ({ server }) {
    const target = yield* findServer(server);
    const result = yield* dumpMappings(target);

    yield* Console.log(
      `${result.generated ? "Dumped" : "Already have"} mappings for build ${result.buildId}: ${target.sshHost}:${result.path}`,
    );
  }),
).pipe(
  Command.withDescription(
    "Make sure the server's host has .usmap mappings for its game build, dumping them in a throwaway Wine server if not",
  ),
);

// open-pal config precedence mirrors the inventory, except that no config at all means every feature is off.
const openPalJson = Effect.gen(function* () {
  const inline = yield* Config.option(Config.String("PALFORGE_OPEN_PAL"));

  if (Option.isSome(inline)) {
    return { source: "$PALFORGE_OPEN_PAL", json: inline.value };
  }

  const file = yield* Config.option(Config.String("PALFORGE_OPEN_PAL_FILE"));

  if (Option.isSome(file)) {
    return { source: file.value, json: yield* readOpenPalJson(file.value) };
  }

  const defaultPath = yield* configPath("open-pal.json");
  const fs = yield* FileSystem.FileSystem;

  return (yield* fs.exists(defaultPath))
    ? { source: defaultPath, json: yield* readOpenPalJson(defaultPath) }
    : { source: `${defaultPath} (not found, every feature off)`, json: "{}" };
});

// `server` selects that server's overrides from the file's `servers` section and the events it runs now.
const loadOpenPal = Effect.fn("loadOpenPal")(function* (server?: string) {
  const { source, json } = yield* openPalJson;
  const now = yield* DateTime.now;

  const events = (yield* decodeOpenPalEvents(json, source)).filter(
    (event) => server !== undefined && isActive(event, server, now),
  );

  return {
    source,
    events,
    config: yield* decodeOpenPalConfig(
      json,
      source,
      server,
      server === undefined ? undefined : now,
    ),
  };
});

const packFeatures = Command.make(
  "features",
  {
    server: Flag.String("server").pipe(
      Flag.withDescription("Show the settings for this server, with its overrides from `servers`"),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ server }) {
    const { source, config } = yield* loadOpenPal(Option.getOrUndefined(server));

    yield* Console.log(
      `open-pal config: ${source}${Option.match(server, { onNone: () => "", onSome: (name) => ` (for ${name})` })}`,
    );

    for (const feature of features) {
      const { enabled, ...settings } = config[feature.id];

      const values = Object.entries(settings)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ");

      yield* Console.log(
        `  [${enabled ? "on " : "off"}] ${feature.title}: ${values} (vanilla: ${feature.vanilla}; checked on build ${feature.checkedOn.join(", ")})`,
      );
    }
  }),
).pipe(Command.withDescription("List open-pal features with their current and vanilla values"));

const packBuild = Command.make(
  "build",
  { server: serverArgument },
  Effect.fn(function* ({ server }) {
    const target = yield* findServer(server);
    const { source, config } = yield* loadOpenPal(target.name);
    const built = yield* buildPack(target, config);

    if (Option.isNone(built)) {
      yield* Console.log(
        `Every open-pal feature is off in ${source}; ${target.name} needs no pack.`,
      );

      return;
    }

    const { pak, manifest } = built.value;

    yield* Console.log(`Built ${target.sshHost}:${pak} for game build ${manifest.gameBuildId}`);
    yield* Console.log(`sha256 ${manifest.pakSha256}`);

    for (const asset of manifest.assets) {
      yield* Console.log(`  ${asset.asset} (${asset.features.join(", ")})`);

      for (const edit of asset.edits) {
        yield* Console.log(`    ${edit.label}: ${edit.from ?? "game default"} -> ${edit.to}`);
      }
    }
  }),
).pipe(
  Command.withDescription(
    "Build the open-pal pak on the server's host from its game files and the open-pal config",
  ),
);

const packDeploy = Command.make(
  "deploy",
  {
    server: serverArgument,
    waitMinutes: Flag.Int("wait-for-empty-minutes").pipe(
      Flag.withDescription("How long to wait for players to leave before the announced restart"),
      Flag.withDefault(0),
    ),
  },
  Effect.fn(function* ({ server, waitMinutes }) {
    const target = yield* findServer(server);
    const { source, config } = yield* loadOpenPal(target.name);
    const built = yield* buildPack(target, config);

    const deployment = yield* deployPack(target, built, {
      waitForEmpty: waitMinutes > 0 ? `${waitMinutes} minutes` : undefined,
    });

    yield* Console.log(
      Option.match(built, {
        onNone: () =>
          `${target.name} runs vanilla, as every open-pal feature is off in ${source} (${deployment.fps} FPS)`,
        onSome: ({ manifest }) =>
          `${target.name} runs OpenPal_P.pak ${manifest.pakSha256.slice(0, 12)} for game build ${manifest.gameBuildId} (${deployment.fps} FPS)`,
      }),
    );
  }),
).pipe(
  Command.withDescription(
    "Build the pack from the open-pal config and install it with an announced, backed-up restart; any failure leaves the server vanilla",
  ),
);

const pack = Command.make("pack").pipe(
  Command.withDescription("Configure, build and deploy the open-pal QoL pack"),
  Command.withSubcommands([packFeatures, packBuild, packDeploy]),
);

const update = Command.make(
  "update",
  {
    server: Argument.String("server").pipe(
      Argument.withDescription("The server to update. Omit it with --all"),
      Argument.optional,
    ),
    all: Flag.Boolean("all").pipe(
      Flag.withDescription(
        "Update every server: canaries first, then the others after the soak period",
      ),
      Flag.withDefault(false),
    ),
    rehearse: Flag.Boolean("rehearse").pipe(
      Flag.withDescription("Run every stage against the build the server already runs"),
      Flag.withDefault(false),
    ),
    failAt: Flag.Literals("fail-at", updateStages).pipe(
      Flag.withDescription("With --rehearse: fail on purpose at this stage"),
      Flag.optional,
    ),
    soakMinutes: Flag.Int("soak-minutes").pipe(
      Flag.withDescription("How long a canary must stay healthy before the other servers update"),
      Flag.withDefault(30),
    ),
    waitMinutes: Flag.Int("wait-for-empty-minutes").pipe(
      Flag.withDescription("How long to wait for players to leave before the announced restart"),
      Flag.withDefault(30),
    ),
  },
  Effect.fn(function* ({ server, all, rehearse, failAt, soakMinutes, waitMinutes }) {
    const options = {
      rehearse,
      waitForEmpty: `${waitMinutes} minutes` as const,
      failAt: Option.getOrUndefined(failAt),
    };

    const targets = all
      ? yield* allServers
      : Option.isSome(server)
        ? [yield* findServer(server.value)]
        : yield* Effect.fail(new Error("Name a server, or use --all"));

    const rollout = yield* Effect.forEach(targets, (target) =>
      loadOpenPal(target.name).pipe(Effect.map(({ config }) => ({ server: target, config }))),
    );

    const results = yield* updateAll(rollout, `${soakMinutes} minutes`, options);

    for (const result of results) {
      yield* Console.log(
        result.updated
          ? `${result.server}: ${result.from} -> ${result.to}${rehearse ? " (rehearsal)" : ""}`
          : `${result.server}: already on build ${result.to}`,
      );
    }
  }),
).pipe(
  Command.withDescription(
    "Update the game: detect a new Steam build, stage it, rebuild the pack, then switch with a backed-up restart",
  ),
);

const palLine = (pal: SavedPal) =>
  `  ${String(pal.slot).padStart(3)}  ${pal.id}  ${pal.species} level ${pal.level}${pal.nickname === null ? "" : ` "${pal.nickname}"`}${pal.expedition ? " (on an expedition)" : ""}`;

const saveShow = Command.make(
  "show",
  {
    server: serverArgument,
    player: Argument.String("player").pipe(
      Argument.withDescription("The player's name in the game, or their player ID"),
    ),
  },
  Effect.fn(function* ({ server, player }) {
    const saved = yield* showPlayer(yield* findServer(server), player);

    yield* Console.log(`${saved.player} (${saved.uid})`);
    yield* Console.log(`Party (${saved.party.length}):`);

    for (const pal of saved.party) {
      yield* Console.log(palLine(pal));
    }

    yield* Console.log(`Palbox (${saved.palbox.length}):`);

    for (const pal of saved.palbox) {
      yield* Console.log(palLine(pal));
    }

    yield* Console.log(`Dimensional Pal Storage (${saved.dps.length}):`);

    for (const pal of saved.dps) {
      yield* Console.log(palLine(pal));
    }

    yield* Console.log(
      `Inventory (${saved.inventory.length} stacks, container ${saved.inventoryId}):`,
    );

    for (const stack of saved.inventory) {
      yield* Console.log(`  ${String(stack.slot).padStart(3)}  ${stack.item} x${stack.count}`);
    }
  }),
).pipe(
  Command.withDescription(
    "List a player's party, Palbox, Dimensional Pal Storage and inventory, with the IDs a save plan uses",
  ),
);

const saveEdit = Command.make(
  "edit",
  {
    server: serverArgument,
    plan: Argument.String("plan").pipe(
      Argument.withDescription("A JSON save plan; see docs/save-edits.md"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Apply the plan to a copy of the saves and print what it would change"),
      Flag.withDefault(false),
    ),
    waitMinutes: Flag.Int("wait-for-empty-minutes").pipe(
      Flag.withDescription("How long to wait for players to leave before the announced restart"),
      Flag.withDefault(0),
    ),
  },
  Effect.fn(function* ({ server, plan, dryRun, waitMinutes }) {
    const target = yield* findServer(server);
    const fs = yield* FileSystem.FileSystem;
    const decoded = yield* decodeSavePlan(yield* fs.readFileString(plan), plan);

    if (dryRun) {
      const preview = yield* previewEdit(target, decoded);

      for (const change of preview.report.changes) {
        yield* Console.log(change);
      }

      yield* Console.log(`Dry run on a copy in ${target.sshHost}:${preview.dir}; nothing changed`);

      return;
    }

    const edit = yield* editSave(target, decoded, {
      waitForEmpty: waitMinutes > 0 ? `${waitMinutes} minutes` : undefined,
    });

    for (const change of edit.report.changes) {
      yield* Console.log(change);
    }

    yield* Console.log(
      `${target.name} runs the edited saves (${edit.fps} FPS); the originals are in ${target.sshHost}:${edit.dir}/original`,
    );
  }),
).pipe(
  Command.withDescription(
    "Apply a save plan with an announced, backed-up restart; any failure puts back the original saves",
  ),
);

const partySet = Command.make(
  "set",
  {
    server: serverArgument,
    player: Argument.String("player").pipe(
      Argument.withDescription("The player's name in the game, or their player ID"),
    ),
    pals: Argument.String("pal").pipe(
      Argument.withDescription("1 to 5 Pal IDs from `palctl save show`, in party order"),
      Argument.between(1, 5),
    ),
  },
  Effect.fn(function* ({ server, player, pals }) {
    const saved = yield* setPartyLive(yield* findServer(server), player, pals);

    yield* Console.log(`${saved.player}'s party, as the server saved it:`);

    for (const pal of saved.party) {
      yield* Console.log(palLine(pal));
    }
  }),
).pipe(
  Command.withDescription(
    "Experimental: set an online player's party without a restart, through the PalforgeLoadout mod on a Wine server",
  ),
);

const party = Command.make("party").pipe(
  Command.withDescription("Change an online player's party"),
  Command.withSubcommands([partySet]),
);

const save = Command.make("save").pipe(
  Command.withDescription("Read and edit the world's saves"),
  Command.withSubcommands([saveShow, saveEdit]),
);

const eventList = Command.make(
  "list",
  {},
  Effect.fn(function* () {
    const { source, json } = yield* openPalJson;
    const events = yield* decodeOpenPalEvents(json, source);
    const now = yield* DateTime.now;

    if (events.length === 0) {
      yield* Console.log(`No events in ${source}`);
    }

    for (const event of events) {
      const state = DateTime.isLessThan(now, event.start)
        ? "upcoming"
        : DateTime.isLessThan(now, event.end)
          ? "running"
          : "ended";

      yield* Console.log(
        `${event.name}: ${state}, ${DateTime.formatIso(event.start)} to ${DateTime.formatIso(event.end)} on ${event.servers?.join(", ") ?? "every server"}`,
      );
      yield* Console.log(`  ${event.message}`);
    }
  }),
).pipe(Command.withDescription("List the events in the open-pal config and whether they run now"));

const eventSync = Command.make(
  "sync",
  {
    server: Argument.String("server").pipe(
      Argument.withDescription("The server to sync. Omit it with --all"),
      Argument.optional,
    ),
    all: Flag.Boolean("all").pipe(
      Flag.withDescription("Sync every server"),
      Flag.withDefault(false),
    ),
    waitMinutes: Flag.Int("wait-for-empty-minutes").pipe(
      Flag.withDescription("How long to wait for players to leave before the announced restart"),
      Flag.withDefault(0),
    ),
  },
  Effect.fn(function* ({ server, all, waitMinutes }) {
    const targets = all
      ? yield* allServers
      : Option.isSome(server)
        ? [yield* findServer(server.value)]
        : yield* Effect.fail(new Error("Name a server, or use --all"));

    for (const target of targets) {
      const { config, events } = yield* loadOpenPal(target.name);

      const result = yield* syncEvents(target, config, events, {
        waitForEmpty: waitMinutes > 0 ? `${waitMinutes} minutes` : undefined,
      });

      const changes = [
        ...result.started.map((name) => `${name} started`),
        ...result.ended.map((name) => `${name} ended`),
      ];

      yield* Console.log(
        `${target.name}: ${result.held ?? (result.deployed ? "deployed" : "pack matches the settings")}${changes.length > 0 ? `; ${changes.join(", ")}` : ""}`,
      );
    }
  }),
).pipe(
  Command.withDescription(
    "Deploy the settings with the events that run now, if the server's pack differs; run it from cron",
  ),
);

const event = Command.make("event").pipe(
  Command.withDescription("Time-boxed QoL boosts from the open-pal config"),
  Command.withSubcommands([eventList, eventSync]),
);

palctl.pipe(
  Command.withSubcommands([status, assets, mappings, pack, save, party, event, update]),
  Command.run({ version: packageJson.version }),
  Effect.provide(PalworldRest.layer),
  Effect.provide(RemoteShell.layerSsh),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
