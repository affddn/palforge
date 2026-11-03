import { Effect, Schema } from "effect";

// UAssetAPI's JSON for one asset. palforge only reads it to find fields; uasset-json applies the edits,
// because JavaScript numbers would round the 64-bit integers an asset can contain.
type Json = Schema.Json;

// Keys and array indexes from the document root to one value.
export type JsonPath = ReadonlyArray<string | number>;

// The property types recipes edit, by the UAssetAPI type that holds them.
const propertyTypes = {
  int: "UAssetAPI.PropertyTypes.Objects.IntPropertyData, UAssetAPI",
  float: "UAssetAPI.PropertyTypes.Objects.FloatPropertyData, UAssetAPI",
  bool: "UAssetAPI.PropertyTypes.Objects.BoolPropertyData, UAssetAPI",
} as const;

// The property type names a tagged property carries; an added property needs its type's name in the name map.
const propertyTypeNames = {
  int: "IntProperty",
  float: "FloatProperty",
  bool: "BoolProperty",
} as const;

export type NumberKind = "int" | "float";

export type FieldKind = keyof typeof propertyTypes;

export interface FieldEdit {
  // Names the field for people reading a build manifest, e.g. `Dungeon_Grass.RequiredSeconds`.
  readonly label: string;
  readonly kind: FieldKind;
  readonly path: JsonPath;
  // `null` when the asset leaves the field at the game's code default, so the edit adds it.
  readonly from: number | boolean | null;
  readonly to: number | boolean;
  // Present when the edit adds the property: what to append and the names it needs in the name map.
  readonly insert?: { readonly property: Json; readonly names: ReadonlyArray<string> };
}

export interface FieldChange {
  readonly path: JsonPath;
  readonly before: Json;
  readonly after: Json;
}

// The game no longer has the field a recipe edits, usually after an update renamed or moved it.
export class RecipeTargetMissing extends Schema.TaggedError<RecipeTargetMissing>()(
  "RecipeTargetMissing",
  { message: Schema.String },
) {}

const isString = Schema.is(Schema.String);

// Shallow on purpose: asset documents run to tens of megabytes, so values are only checked where they are read.
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const isObject = (value: Json | undefined): value is Schema.JsonObject =>
  !Array.isArray(value) && isRecord(value);

const isArray = (value: Json | undefined): value is Schema.JsonArray => Array.isArray(value);

const isNumber = Schema.is(Schema.Number);

const isBoolean = Schema.is(Schema.Boolean);

interface Located<A> {
  readonly path: JsonPath;
  readonly value: A;
}

// Finds the property `property` of the given type in a list of UAssetAPI properties at `path`.
const propertyIn = (
  properties: Json | undefined,
  path: JsonPath,
  property: string,
  kind: FieldKind,
) => {
  const index = isArray(properties)
    ? properties.findIndex((entry) => isObject(entry) && entry["Name"] === property)
    : -1;

  const entry = isArray(properties) ? properties[index] : undefined;

  return isObject(entry) && entry["$type"] === propertyTypes[kind]
    ? { path: [...path, index, "Value"], value: entry["Value"] }
    : undefined;
};

const numberIn = (
  properties: Json | undefined,
  path: JsonPath,
  property: string,
  kind: NumberKind,
) => {
  const found = propertyIn(properties, path, property, kind);

  return found !== undefined && isNumber(found.value)
    ? ({ path: found.path, value: found.value } satisfies Located<number>)
    : undefined;
};

const flagIn = (properties: Json | undefined, path: JsonPath, property: string) => {
  const found = propertyIn(properties, path, property, "bool");

  return found !== undefined && isBoolean(found.value)
    ? ({ path: found.path, value: found.value } satisfies Located<boolean>)
    : undefined;
};

const exportsOf = (asset: Json) =>
  isObject(asset) && isArray(asset["Exports"]) ? asset["Exports"] : [];

// A number property on one export, such as a Blueprint's class defaults (`Default__<Class>_C`) or a component
// template (`<Name>_GEN_VARIABLE`).
export const exportNumber = (asset: Json, exportName: string, property: string, kind: NumberKind) =>
  Effect.gen(function* () {
    const exports = exportsOf(asset);

    const index = exports.findIndex(
      (entry) => isObject(entry) && entry["ObjectName"] === exportName,
    );

    const target = exports[index];

    const located = isObject(target)
      ? numberIn(target["Data"], ["Exports", index, "Data"], property, kind)
      : undefined;

    if (located === undefined) {
      return yield* new RecipeTargetMissing({
        message: `No ${kind} property ${property} on export ${exportName}`,
      });
    }

    return located;
  });

// A property in the shape UAssetAPI 1.1.0 serializes it, for adding to an export.
const newProperty = (name: string, kind: FieldKind, value: number | boolean) => ({
  $type: propertyTypes[kind],
  Name: name,
  ArrayIndex: 0,
  PropertyGuid: null,
  IsZero: false,
  PropertyTagFlags: "None",
  PropertyTypeName: null,
  PropertyTagExtensions: "NoExtension",
  Value: value,
});

// Sets a number property on an export to `to(vanilla)`. When the asset leaves the property at the game's code default
// there is nothing to change, so the edit adds the property with `to(null)`.
export const exportNumberEdit = (
  asset: Json,
  exportName: string,
  property: string,
  kind: NumberKind,
  to: (from: number | null) => number,
) =>
  Effect.gen(function* () {
    const exports = exportsOf(asset);

    const index = exports.findIndex(
      (entry) => isObject(entry) && entry["ObjectName"] === exportName,
    );

    const target = exports[index];
    const data = isObject(target) ? target["Data"] : undefined;

    if (!isArray(data)) {
      return yield* new RecipeTargetMissing({ message: `No export ${exportName}` });
    }

    const dataPath = ["Exports", index, "Data"];
    const located = numberIn(data, dataPath, property, kind);
    const label = `${exportName}.${property}`;

    if (located !== undefined) {
      return {
        label,
        kind,
        path: located.path,
        from: located.value,
        to: to(located.value),
      } satisfies FieldEdit;
    }

    if (data.some((entry) => isObject(entry) && entry["Name"] === property)) {
      return yield* new RecipeTargetMissing({
        message: `${property} on export ${exportName} is not a ${kind} property`,
      });
    }

    const value = to(null);

    return {
      label,
      kind,
      path: [...dataPath, data.length, "Value"],
      from: null,
      to: value,
      insert: {
        property: newProperty(property, kind, value),
        names: [property, propertyTypeNames[kind]],
      },
    } satisfies FieldEdit;
  });

// Finds `property` in every row of a DataTable, with each row's name; fails naming the rows that lack it.
const everyRow = <A>(
  asset: Json,
  property: string,
  find: (properties: Json | undefined, path: JsonPath) => Located<A> | undefined,
) =>
  Effect.gen(function* () {
    const exports = exportsOf(asset);
    const index = exports.findIndex((entry) => isObject(entry) && isObject(entry["Table"]));
    const target = exports[index];
    const table = isObject(target) ? target["Table"] : undefined;
    const rows = isObject(table) && isArray(table["Data"]) ? table["Data"] : [];

    if (rows.length === 0) {
      return yield* new RecipeTargetMissing({ message: "The asset has no DataTable rows" });
    }

    const located = rows.map((row, rowIndex) => {
      const name = isObject(row) ? row["Name"] : undefined;

      const field = isObject(row)
        ? find(row["Value"], ["Exports", index, "Table", "Data", rowIndex, "Value"])
        : undefined;

      return { row: isString(name) ? name : `#${rowIndex}`, field };
    });

    const fields = located.flatMap((entry) =>
      entry.field === undefined ? [] : [{ row: entry.row, ...entry.field }],
    );

    if (fields.length < rows.length) {
      const missing = located
        .filter((entry) => entry.field === undefined)
        .map((entry) => entry.row);

      return yield* new RecipeTargetMissing({
        message: `Rows without the property ${property}: ${missing.join(", ")}`,
      });
    }

    return fields;
  });

// A number property in every row of a DataTable.
export const dataTableNumbers = (asset: Json, property: string, kind: NumberKind) =>
  everyRow(asset, property, (properties, path) => numberIn(properties, path, property, kind));

// A bool property in every row of a DataTable.
export const dataTableFlags = (asset: Json, property: string) =>
  everyRow(asset, property, (properties, path) => flagIn(properties, path, property));

const samePath = (left: JsonPath, right: JsonPath) =>
  left.length === right.length && left.every((segment, index) => segment === right[index]);

// UAssetAPI writes a float property back at single precision, so a planned float matches at that precision.
const sameValue = (edit: FieldEdit, value: Json) =>
  edit.kind === "float" && isNumber(edit.to) && isNumber(value)
    ? Math.fround(edit.to) === Math.fround(value)
    : edit.to === value;

// What `uasset-json diff` reports: every changed leaf, with `null` for a side that does not exist.
export const FieldChanges = Schema.Array(
  Schema.Struct({
    path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
    before: Schema.Json,
    after: Schema.Json,
  }),
);

// A set edit changes the value at its path; an added property appears whole at the index it was appended to.
const plannedBy = (edit: FieldEdit, change: FieldChange) =>
  edit.insert === undefined
    ? samePath(edit.path, change.path) && sameValue(edit, change.after)
    : samePath(edit.path.slice(0, -1), change.path) &&
      change.before === null &&
      isObject(change.after) &&
      sameValue(edit, change.after["Value"] ?? null);

// Adding a property moves everything written after it, so UAssetAPI recomputes these layout numbers.
const layoutField = /Offset$|^SerialSize$|^NameCount$/u;

const isLayoutChange = (change: FieldChange) =>
  isNumber(change.before) && isNumber(change.after) && layoutField.test(String(change.path.at(-1)));

const isAddedName = (change: FieldChange, names: ReadonlyArray<string>) =>
  change.path.length === 2 &&
  change.path[0] === "NameMap" &&
  change.before === null &&
  names.some((name) => name === change.after);

// A rebuilt asset may differ from vanilla only where the recipe said, and only to the value it said. When the recipe
// adds properties, the asset may also gain their names and new layout numbers, and nothing else.
export const unexpectedChanges = (
  changes: ReadonlyArray<FieldChange>,
  edits: ReadonlyArray<FieldEdit>,
) => {
  const addedNames = edits.flatMap((edit) => edit.insert?.names ?? []);
  const adds = addedNames.length > 0;

  const unplanned = changes.filter(
    (change) =>
      !edits.some((edit) => plannedBy(edit, change)) &&
      !(adds && (isLayoutChange(change) || isAddedName(change, addedNames))),
  );

  const unapplied = edits.filter(
    (edit) =>
      (edit.from === null || !sameValue(edit, edit.from)) &&
      !changes.some((change) => plannedBy(edit, change)),
  );

  return { unplanned, unapplied };
};
