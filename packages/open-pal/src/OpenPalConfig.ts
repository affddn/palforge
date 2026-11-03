import { DateTime, Effect, FileSystem, Schema } from "effect";

// Every feature is off unless the operator enables it, so a missing config means a vanilla server.
const off = Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false)));

export class GuildChest extends Schema.Class<GuildChest>("@palforge/open-pal/GuildChest")({
  enabled: off,
  slots: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 54, maximum: 960 })),
    Schema.withDecodingDefaultKey(Effect.succeed(444)),
  ),
}) {}

export class Storage extends Schema.Class<Storage>("@palforge/open-pal/Storage")({
  enabled: off,
  slotMultiplier: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
    Schema.withDecodingDefaultKey(Effect.succeed(2)),
  ),
}) {}

export class Expeditions extends Schema.Class<Expeditions>("@palforge/open-pal/Expeditions")({
  enabled: off,
  durationMultiplier: Schema.Number.pipe(
    Schema.check(Schema.isBetween({ minimum: 0.05, maximum: 1 })),
    Schema.withDecodingDefaultKey(Effect.succeed(0.25)),
  ),
}) {}

const number = (minimum: number, maximum: number, fallback: number) =>
  Schema.Number.pipe(
    Schema.check(Schema.isBetween({ minimum, maximum })),
    Schema.withDecodingDefaultKey(Effect.succeed(fallback)),
  );

export class Breeding extends Schema.Class<Breeding>("@palforge/open-pal/Breeding")({
  enabled: off,
  timeMultiplier: number(0.1, 1, 0.5),
}) {}

export class PalboxRest extends Schema.Class<PalboxRest>("@palforge/open-pal/PalboxRest")({
  enabled: off,
  sanityRegenMultiplier: number(1, 10, 4),
  sickRecoveryMultiplier: number(1, 5, 2),
}) {}

// The rows of DT_BaseCampWorkerEventDataTable in game build 25247047.
export const workerEvents = [
  "DestroyBuilding",
  "DodgeWork",
  "DodgeWork_Short",
  "DodgeWork_Sleep",
  "EatTooMuch",
  "TurnFoodBox",
  "FightWithFriend",
  "Trantrum",
  "Escape",
  "OverworkDeath",
  "Sick",
] as const;

export class CalmWorkers extends Schema.Class<CalmWorkers>("@palforge/open-pal/CalmWorkers")({
  enabled: off,
  disabledEvents: Schema.Array(Schema.Literals(workerEvents)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(["TurnFoodBox", "EatTooMuch", "Trantrum"])),
  ),
  triggerProbability: number(0, 50, 50),
}) {}

export class Crops extends Schema.Class<Crops>("@palforge/open-pal/Crops")({
  enabled: off,
  growthMultiplier: number(0.1, 1, 0.5),
  workMultiplier: number(0.25, 1, 0.5),
}) {}

// One slot count for the Feed Box, the Cold Food Box and the fridge. The default is the most any container gets.
export class FoodStorage extends Schema.Class<FoodStorage>("@palforge/open-pal/FoodStorage")({
  enabled: off,
  slots: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 50, maximum: 444 })),
    Schema.withDecodingDefaultKey(Effect.succeed(444)),
  ),
}) {}

export class LabResearch extends Schema.Class<LabResearch>("@palforge/open-pal/LabResearch")({
  enabled: off,
  workMultiplier: number(0.25, 1, 0.5),
}) {}

export class TechPoints extends Schema.Class<TechPoints>("@palforge/open-pal/TechPoints")({
  enabled: off,
  pointsPerLevel: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 6, maximum: 12 })),
    Schema.withDecodingDefaultKey(Effect.succeed(8)),
  ),
}) {}

const feature = <S extends Schema.Top>(schema: S) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed({})));

export class OpenPalConfig extends Schema.Class<OpenPalConfig>("@palforge/open-pal/OpenPalConfig")({
  guildChest: feature(GuildChest),
  storage: feature(Storage),
  expeditions: feature(Expeditions),
  breeding: feature(Breeding),
  palboxRest: feature(PalboxRest),
  calmWorkers: feature(CalmWorkers),
  crops: feature(Crops),
  foodStorage: feature(FoodStorage),
  labResearch: feature(LabResearch),
  techPoints: feature(TechPoints),
}) {}

export const OpenPalConfigJson = Schema.fromJsonString(OpenPalConfig);

export const vanillaConfig = Schema.decodeSync(OpenPalConfig)({});

export class OpenPalConfigError extends Schema.TaggedError<OpenPalConfigError>()(
  "OpenPalConfigError",
  {
    source: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const isObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  !Array.isArray(value) && isRecord(value);

// A key the schema does not know is a typo, so it fails instead of being ignored.
const decodeStrict = Schema.decodeUnknownEffect(OpenPalConfig, { onExcessProperty: "error" });

// One server's settings: the shared ones, with that server's overrides merged in feature by feature.
const forServer = (shared: Schema.JsonObject, overrides: Schema.Json | undefined) =>
  isObject(overrides)
    ? Object.fromEntries(
        [...new Set([...Object.keys(shared), ...Object.keys(overrides)])].map((key) => {
          const base = shared[key];
          const override = overrides[key];

          return [
            key,
            isObject(base) && isObject(override)
              ? Object.fromEntries([...Object.entries(base), ...Object.entries(override)])
              : (override ?? base ?? null),
          ];
        }),
      )
    : shared;

// A time-boxed boost: feature settings that apply from `start` until `end`, on top of a server's own settings.
export class OpenPalEvent extends Schema.Class<OpenPalEvent>("@palforge/open-pal/OpenPalEvent")({
  name: Schema.String,
  start: Schema.DateTimeUtcFromString,
  end: Schema.DateTimeUtcFromString,
  // Shown in game when the event starts.
  message: Schema.NonEmptyString,
  // The servers that run the event; every server when absent.
  servers: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
}) {}

const decodeEvent = Schema.decodeUnknownEffect(OpenPalEvent, { onExcessProperty: "error" });

export const isActive = (event: OpenPalEvent, server: string, at: DateTime.Utc) =>
  (event.servers === undefined || event.servers.includes(server)) &&
  DateTime.isLessThanOrEqualTo(event.start, at) &&
  DateTime.isLessThan(at, event.end);

// The file holds the settings for every server, under `servers` the settings that differ for a named server, and
// under `events` the time-boxed boosts with their own settings.
const parseDocument = (json: string) =>
  Effect.gen(function* () {
    const document = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(json);

    if (!isObject(document)) {
      return yield* Effect.fail(new Error("the config must be a JSON object"));
    }

    const servers = document["servers"];
    const eventList = document["events"];

    if (servers !== undefined && !isObject(servers)) {
      return yield* Effect.fail(new Error("`servers` must map server names to their settings"));
    }

    if (eventList !== undefined && !isObject(eventList)) {
      return yield* Effect.fail(new Error("`events` must map event names to events"));
    }

    const shared = Object.fromEntries(
      Object.entries(document).filter(([key]) => key !== "servers" && key !== "events"),
    );

    const events = yield* Effect.forEach(Object.entries(eventList ?? {}), ([name, entry]) =>
      Effect.gen(function* () {
        if (!isObject(entry) || !isObject(entry["features"])) {
          return yield* Effect.fail(new Error(`events.${name} must have a \`features\` object`));
        }

        const { features: settings, ...rest } = entry;

        const event = yield* decodeEvent({ ...rest, name }).pipe(
          Effect.mapError((cause) => new Error(`events.${name}: ${cause.message}`)),
        );

        if (!DateTime.isLessThan(event.start, event.end)) {
          return yield* Effect.fail(new Error(`events.${name} must end after it starts`));
        }

        return { event, settings };
      }),
    );

    return { shared, servers: servers ?? {}, events };
  });

// Every server's merged settings, and each event on top of them, are checked, so a typo in one override or event
// fails even when deploying another server.
// `source` names where the JSON came from (a file path or an environment variable) for error messages.
// With `at`, the events active then for `server` apply.
export const decodeOpenPalConfig = (
  json: string,
  source: string,
  server?: string,
  at?: DateTime.Utc,
) =>
  Effect.gen(function* () {
    const { shared, servers, events } = yield* parseDocument(json);

    for (const [name, overrides] of Object.entries(servers)) {
      const own = forServer(shared, overrides);

      yield* decodeStrict(own).pipe(
        Effect.mapError((cause) => new Error(`servers.${name}: ${cause.message}`)),
      );

      for (const { event, settings } of events) {
        yield* decodeStrict(forServer(own, settings)).pipe(
          Effect.mapError(
            (cause) => new Error(`events.${event.name} on ${name}: ${cause.message}`),
          ),
        );
      }
    }

    for (const { event, settings } of events) {
      yield* decodeStrict(forServer(shared, settings)).pipe(
        Effect.mapError((cause) => new Error(`events.${event.name}: ${cause.message}`)),
      );
    }

    const own = forServer(shared, server === undefined ? undefined : servers[server]);

    const active = events.filter(
      ({ event }) => server !== undefined && at !== undefined && isActive(event, server, at),
    );

    return yield* decodeStrict(
      active.reduce((settings, event) => forServer(settings, event.settings), own),
    );
  }).pipe(
    Effect.mapError(
      (cause) =>
        new OpenPalConfigError({
          source,
          message: `Invalid open-pal config in ${source}: ${cause.message}`,
          cause,
        }),
    ),
  );

// The events in the config, in the order they start.
export const decodeOpenPalEvents = (json: string, source: string) =>
  parseDocument(json).pipe(
    Effect.map(({ events }) =>
      events
        .map(({ event }) => event)
        .toSorted((left, right) => DateTime.Order(left.start, right.start)),
    ),
    Effect.mapError(
      (cause) =>
        new OpenPalConfigError({
          source,
          message: `Invalid open-pal config in ${source}: ${cause.message}`,
          cause,
        }),
    ),
  );

export const readOpenPalJson = (path: string) =>
  FileSystem.FileSystem.use((fs) => fs.readFileString(path)).pipe(
    Effect.mapError(
      (cause) =>
        new OpenPalConfigError({
          source: path,
          message: `Could not read the open-pal config at ${path}: ${cause.message}`,
          cause,
        }),
    ),
  );

export const readOpenPalConfig = (path: string, server?: string, at?: DateTime.Utc) =>
  readOpenPalJson(path).pipe(Effect.flatMap((json) => decodeOpenPalConfig(json, path, server, at)));

// Steam builds of Palworld each feature was built, checked and deployed on. A new game build needs a new check.
const checkedOn = ["25247047 (v1.0.5)"];

export const features = [
  { id: "guildChest", title: "Guild chest slots", vanilla: "54 slots", checkedOn },
  { id: "storage", title: "Chest slots", vanilla: "24, 40 and 54 slots", checkedOn },
  { id: "expeditions", title: "Pal expedition duration", vanilla: "30 to 120 minutes", checkedOn },
  { id: "breeding", title: "Breeding Farm time", vanilla: "300 seconds per egg", checkedOn },
  {
    id: "palboxRest",
    title: "Palbox rest and recovery",
    vanilla: "2% sanity per second, 3% to 20% sickness recovery per check",
    checkedOn,
  },
  {
    id: "calmWorkers",
    title: "Calm base workers",
    vanilla: "all worker events on, 50% trigger chance",
    checkedOn,
  },
  {
    id: "crops",
    title: "Crop growth and farm work",
    vanilla: "180 to 390 seconds to grow",
    checkedOn,
  },
  {
    id: "foodStorage",
    title: "Feed Box, Cold Food Box and fridge slots",
    vanilla: "Cold Food Box 30, fridge 25",
    checkedOn,
  },
  {
    id: "labResearch",
    title: "Lab research work",
    vanilla: "each research's own work amount",
    checkedOn,
  },
  { id: "techPoints", title: "Technology points per level", vanilla: "6 points", checkedOn },
] as const;
