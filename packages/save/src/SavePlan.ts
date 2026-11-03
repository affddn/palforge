import { Effect, Schema } from "effect";

// Pal and container IDs as the saves print them.
const Guid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
);

// A player's name in the game, or their player ID.
const Player = Schema.NonEmptyString;

// Moves one of a player's Pals between their party, Palbox and Dimensional Pal Storage (9,600 entries).
export const MovePal = Schema.Struct({
  op: Schema.Literal("movePal"),
  pal: Guid,
  to: Schema.Literals(["party", "palbox", "dps"]),
  slot: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9599 }))),
});

// Makes the player's party exactly these Pals; the others go to the Palbox.
export const SetParty = Schema.Struct({
  op: Schema.Literal("setParty"),
  player: Player,
  pals: Schema.Array(Guid).check(Schema.isMaxLength(5)),
});

// Adds a stackable item, such as Money or Wood, to the player's inventory.
export const GiveItem = Schema.Struct({
  op: Schema.Literal("giveItem"),
  player: Player,
  item: Schema.String.check(Schema.isPattern(/^\w+$/u)),
  count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 9999 })),
});

// Puts back an item container's slots as an older Level.sav holds them. `from` is a path on the server host: a
// Level.sav, or a backup archive that holds the world's Level.sav.
export const RestoreContainer = Schema.Struct({
  op: Schema.Literal("restoreContainer"),
  container: Guid,
  from: Schema.String.check(Schema.isPattern(/^\/\S+(?:\.sav|\.tar\.gz)$/u)),
});

export class SavePlan extends Schema.Class<SavePlan>("@palforge/save/SavePlan")({
  operations: Schema.NonEmptyArray(Schema.Union([MovePal, SetParty, GiveItem, RestoreContainer])),
}) {}

export class SavePlanError extends Schema.TaggedError<SavePlanError>()("SavePlanError", {
  source: Schema.String,
  message: Schema.String,
}) {}

const decodeStrict = Schema.decodeUnknownEffect(SavePlan, { onExcessProperty: "error" });

// `source` names where the JSON came from, for error messages.
export const decodeSavePlan = (json: string, source: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(json).pipe(
    Effect.flatMap(decodeStrict),
    Effect.mapError(
      (cause) =>
        new SavePlanError({ source, message: `Invalid save plan in ${source}: ${cause.message}` }),
    ),
  );
