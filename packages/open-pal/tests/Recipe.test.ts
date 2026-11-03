import { Effect, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  FieldChanges,
  OpenPalConfig,
  RecipeTargetMissing,
  recipeFor,
  unexpectedChanges,
} from "#src/index.ts";
import type { FieldEdit } from "#src/index.ts";

// Property objects as UAssetAPI 1.1.0 serializes them, with values from Palworld 1.0.5 (build 25247047).
const property = (type: string, name: string, value: number | boolean) => ({
  $type: `UAssetAPI.PropertyTypes.Objects.${type}PropertyData, UAssetAPI`,
  Name: name,
  ArrayIndex: 0,
  PropertyGuid: null,
  Value: value,
});

const int = (name: string, value: number) => property("Int", name, value);
const float = (name: string, value: number) => property("Float", name, value);
const bool = (name: string, value: boolean) => property("Bool", name, value);

type Property = ReturnType<typeof property>;

const blueprint = (exportName: string, data: ReadonlyArray<Property>): Schema.Json => ({
  Exports: [
    { ObjectName: "Class_C", Data: [] },
    { ObjectName: exportName, Data: data },
  ],
});

const dataTable = (rows: ReadonlyArray<[string, ReadonlyArray<Property>]>): Schema.Json => ({
  Exports: [
    {
      $type: "UAssetAPI.ExportTypes.DataTableExport, UAssetAPI",
      Table: { Data: rows.map(([name, value]) => ({ Name: name, Value: value })) },
    },
  ],
});

const gameSettings = blueprint("Default__BP_PalGameSetting_C", [
  int("GuildCharacterMaxLevel", 30),
  int("GuildChestSlotNum", 54),
  float("AutoSANRegene_Percent_perSecond_PalStorage", 0.02),
  float("BaseCampWorkerEventTriggerProbability", 50),
  int("technologyPointPerLevel", 6),
]);

const assets = {
  BP_PalGameSetting: gameSettings,
  DT_CharacterTeamMissionDataTable: dataTable([
    ["Dungeon_Grass", [int("RequiredSeconds", 1800)]],
    ["Dungeon_GrassHard", [int("RequiredSeconds", 7200)]],
  ]),
  BP_BuildObject_BreedFarm: blueprint("BreedFarmParameter_GEN_VARIABLE", [
    float("BreedRequiredRealTime", 300),
  ]),
  DT_BaseCampWorkerSickDataTable: dataTable([
    ["NoneSick", [int("RecoveryProbabilityPercentageInPalBox", 0)]],
    ["Cold", [int("RecoveryProbabilityPercentageInPalBox", 20)]],
    ["Sprain", [int("RecoveryProbabilityPercentageInPalBox", 60)]],
  ]),
  DT_BaseCampWorkerEventDataTable: dataTable([
    ["DestroyBuilding", [int("TriggerSanity", 50), bool("Invalid", true)]],
    ["TurnFoodBox", [int("TriggerSanity", 30), bool("Invalid", false)]],
    ["Sick", [int("TriggerSanity", 10), bool("Invalid", false)]],
  ]),
  DT_MapObjectFarmCrop: dataTable([
    [
      "Wheat",
      [
        float("GrowupTime", 270),
        int("CropItemNum", 10),
        float("SeedingWorkAmount", 7500),
        float("WateringWorkAmount", 7500),
        float("HarvestWorkAmount", 7500),
      ],
    ],
  ]),
  BP_BuildObject_ItemChest_04: blueprint("PalMapObjectItemChestParameter_GEN_VARIABLE", [
    int("SlotNum", 54),
  ]),
  BP_BuildObject_ItemChest_03: blueprint("PalMapObjectItemChestParameter_GEN_VARIABLE", [
    int("SlotNum", 200),
  ]),
  BP_BuildObject_Refrigerator: blueprint("PalMapObjectItemChestParameter_GEN_VARIABLE", [
    int("SlotNum", 25),
  ]),
  // The Feed Box leaves SlotNum at the game's code default, so its component has no properties.
  BP_BuildObject_PalFoodBox: blueprint("FoodBoxParameter_GEN_VARIABLE", []),
  BP_BuildObject_PalFoodBoxCool: blueprint("FoodBoxParameter_GEN_VARIABLE", [int("SlotNum", 30)]),
  DT_LabResearchDataTable: dataTable([["Handcraft1", [int("RequiredWorkAmount", 50001)]]]),
};

const vanillaOf = (asset: string) =>
  Object.entries(assets).find(([name]) => asset.endsWith(`/${name}`))?.[1];

// Every edit the config makes, keyed by feature, computed against the fixtures above.
const editsFor = async (json: string) => {
  const config = await Effect.runPromise(
    Schema.decodeEffect(Schema.fromJsonString(OpenPalConfig))(json),
  );

  const recipes = await Effect.runPromise(recipeFor(config));
  const edits: Array<{ feature: string; asset: string } & FieldEdit> = [];

  for (const recipe of recipes) {
    const vanilla = vanillaOf(recipe.asset);

    if (vanilla !== undefined) {
      for (const edit of await Effect.runPromise(recipe.edits(vanilla))) {
        edits.push({
          feature: recipe.feature,
          asset: recipe.asset.split("/").at(-1) ?? "",
          ...edit,
        });
      }
    }
  }

  return edits;
};

const summary = (edits: ReadonlyArray<FieldEdit>) =>
  edits.map((edit) => [edit.label, edit.kind, edit.from, edit.to]);

describe("open-pal recipes", () => {
  it("builds nothing for a vanilla config", async () => {
    expect(await editsFor("{}")).toEqual([]);
  });

  it("sets the guild chest slot count", async () => {
    const edits = await editsFor(`{"guildChest":{"enabled":true,"slots":444}}`);

    expect(edits).toEqual([
      {
        feature: "guildChest",
        asset: "BP_PalGameSetting",
        label: "Default__BP_PalGameSetting_C.GuildChestSlotNum",
        kind: "int",
        path: ["Exports", 1, "Data", 1, "Value"],
        from: 54,
        to: 444,
      },
    ]);
  });

  it("scales every expedition", async () => {
    const edits = await editsFor(`{"expeditions":{"enabled":true,"durationMultiplier":0.25}}`);

    expect(summary(edits)).toEqual([
      ["Dungeon_Grass.RequiredSeconds", "int", 1800, 450],
      ["Dungeon_GrassHard.RequiredSeconds", "int", 7200, 1800],
    ]);
  });

  it("shortens the Breeding Farm time as a float", async () => {
    const edits = await editsFor(`{"breeding":{"enabled":true,"timeMultiplier":0.5}}`);

    expect(summary(edits)).toEqual([
      ["BreedFarmParameter_GEN_VARIABLE.BreedRequiredRealTime", "float", 300, 150],
    ]);
  });

  it("speeds up Palbox rest and caps sickness recovery at 100%", async () => {
    const edits = await editsFor(
      `{"palboxRest":{"enabled":true,"sanityRegenMultiplier":4,"sickRecoveryMultiplier":2}}`,
    );

    expect(summary(edits)).toEqual([
      [
        "Default__BP_PalGameSetting_C.AutoSANRegene_Percent_perSecond_PalStorage",
        "float",
        0.02,
        0.08,
      ],
      ["NoneSick.RecoveryProbabilityPercentageInPalBox", "int", 0, 0],
      ["Cold.RecoveryProbabilityPercentageInPalBox", "int", 20, 40],
      ["Sprain.RecoveryProbabilityPercentageInPalBox", "int", 60, 100],
    ]);
  });

  it("turns off only the chosen worker events and sets the trigger chance", async () => {
    const edits = await editsFor(
      `{"calmWorkers":{"enabled":true,"disabledEvents":["TurnFoodBox","DestroyBuilding"],"triggerProbability":25}}`,
    );

    expect(summary(edits)).toEqual([
      ["DestroyBuilding.Invalid", "bool", true, true],
      ["TurnFoodBox.Invalid", "bool", false, true],
      ["Default__BP_PalGameSetting_C.BaseCampWorkerEventTriggerProbability", "float", 50, 25],
    ]);
  });

  it("speeds up crop growth and farm work separately", async () => {
    const edits = await editsFor(
      `{"crops":{"enabled":true,"growthMultiplier":0.5,"workMultiplier":0.25}}`,
    );

    expect(summary(edits)).toEqual([
      ["Wheat.GrowupTime", "float", 270, 135],
      ["Wheat.SeedingWorkAmount", "float", 7500, 1875],
      ["Wheat.WateringWorkAmount", "float", 7500, 1875],
      ["Wheat.HarvestWorkAmount", "float", 7500, 1875],
    ]);
  });

  it("multiplies chest slots but never past 444", async () => {
    const edits = await editsFor(`{"storage":{"enabled":true,"slotMultiplier":4}}`);

    expect(edits.map((edit) => [edit.asset, edit.from, edit.to])).toEqual([
      ["BP_BuildObject_ItemChest_03", 200, 444],
      ["BP_BuildObject_ItemChest_04", 54, 216],
    ]);
  });

  it("sets the food containers' slots, adding the Feed Box's field that the game keeps at its default", async () => {
    const edits = await editsFor(`{"foodStorage":{"enabled":true}}`);

    expect(
      edits.map((edit) => [edit.asset, edit.from, edit.to, edit.insert === undefined]),
    ).toEqual([
      ["BP_BuildObject_PalFoodBox", null, 444, false],
      ["BP_BuildObject_PalFoodBoxCool", 30, 444, true],
      ["BP_BuildObject_Refrigerator", 25, 444, true],
    ]);

    expect(edits[0]).toMatchObject({
      path: ["Exports", 1, "Data", 0, "Value"],
      insert: {
        property: {
          $type: "UAssetAPI.PropertyTypes.Objects.IntPropertyData, UAssetAPI",
          Name: "SlotNum",
          Value: 444,
        },
        names: ["SlotNum", "IntProperty"],
      },
    });
  });

  it("refuses to add a field that exists with another type", async () => {
    const config = await Effect.runPromise(
      Schema.decodeEffect(Schema.fromJsonString(OpenPalConfig))(`{"foodStorage":{"enabled":true}}`),
    );

    const [feedBox] = await Effect.runPromise(recipeFor(config));
    const asFloat = blueprint("FoodBoxParameter_GEN_VARIABLE", [float("SlotNum", 30)]);
    const error = await Effect.runPromise(Effect.flip(feedBox?.edits(asFloat) ?? Effect.never));

    expect(error).toBeInstanceOf(RecipeTargetMissing);
    expect(error.message).toContain("is not a int property");
  });

  it("rounds scaled lab research work to whole numbers", async () => {
    const edits = await editsFor(`{"labResearch":{"enabled":true,"workMultiplier":0.5}}`);

    expect(summary(edits)).toEqual([["Handcraft1.RequiredWorkAmount", "int", 50001, 25001]]);
  });

  it("sets the technology points per level", async () => {
    const edits = await editsFor(`{"techPoints":{"enabled":true,"pointsPerLevel":9}}`);

    expect(summary(edits)).toEqual([
      ["Default__BP_PalGameSetting_C.technologyPointPerLevel", "int", 6, 9],
    ]);
  });

  it("fails when the game no longer has the field, or has it with another type", async () => {
    const config = await Effect.runPromise(
      Schema.decodeEffect(Schema.fromJsonString(OpenPalConfig))(`{"breeding":{"enabled":true}}`),
    );

    const [breeding] = await Effect.runPromise(recipeFor(config));

    const asInt = blueprint("BreedFarmParameter_GEN_VARIABLE", [int("BreedRequiredRealTime", 300)]);

    for (const vanilla of [gameSettings, asInt]) {
      const error = await Effect.runPromise(Effect.flip(breeding?.edits(vanilla) ?? Effect.never));

      expect(error).toBeInstanceOf(RecipeTargetMissing);
      expect(error.message).toContain("float property BreedRequiredRealTime");
    }
  });
});

describe("rebuilt asset check", () => {
  const slots: FieldEdit = {
    label: "GuildChestSlotNum",
    kind: "int",
    path: ["Exports", 1, "Data", 1, "Value"],
    from: 54,
    to: 444,
  };

  const planned = { path: ["Exports", 1, "Data", 1, "Value"], before: 54, after: 444 };

  it("accepts a rebuild that changed exactly the recipe's fields", () => {
    expect(unexpectedChanges([planned], [slots])).toEqual({ unplanned: [], unapplied: [] });
  });

  it("rejects a rebuild that changed a field outside the recipe", () => {
    const outside = { path: ["Exports", 1, "Data", 0, "Value"], before: 30, after: 99 };

    expect(unexpectedChanges([planned, outside], [slots]).unplanned).toEqual([outside]);
  });

  it("rejects a rebuild that set a recipe field to another value", () => {
    const wrong = { ...planned, after: 445 };

    expect(unexpectedChanges([wrong], [slots])).toEqual({ unplanned: [wrong], unapplied: [slots] });
  });

  it("rejects a rebuild that is missing a recipe edit", () => {
    expect(unexpectedChanges([], [slots]).unapplied).toEqual([slots]);
  });

  it("matches floats at the single precision UAssetAPI writes them", () => {
    const rate: FieldEdit = { ...slots, label: "rate", kind: "float", from: 0.1, to: 0.1 * 3 };
    const written = { ...planned, before: 0.1, after: 0.3 };

    expect(unexpectedChanges([written], [rate])).toEqual({ unplanned: [], unapplied: [] });
  });

  it("matches bool edits exactly", () => {
    const flag: FieldEdit = { ...slots, label: "Invalid", kind: "bool", from: false, to: true };

    expect(unexpectedChanges([{ ...planned, before: false, after: true }], [flag])).toEqual({
      unplanned: [],
      unapplied: [],
    });
  });

  describe("with an added property", () => {
    const added: FieldEdit = {
      label: "FoodBoxParameter_GEN_VARIABLE.SlotNum",
      kind: "int",
      path: ["Exports", 6, "Data", 0, "Value"],
      from: null,
      to: 444,
      insert: { property: { Name: "SlotNum", Value: 444 }, names: ["SlotNum", "IntProperty"] },
    };

    // What uasset-json diff reported on the canary after adding SlotNum to the Feed Box (abridged).
    const rebuilt = [
      { path: ["NameMap", 164], before: null, after: "SlotNum" },
      { path: ["NameMap", 165], before: null, after: "IntProperty" },
      { path: ["Exports", 0, "SerialOffset"], before: 9434, after: 9470 },
      { path: ["Exports", 6, "Data", 0], before: null, after: { Name: "SlotNum", Value: 444 } },
      { path: ["Exports", 6, "SerialSize"], before: 16, after: 45 },
      { path: ["Generations", 0, "NameCount"], before: 164, after: 166 },
      { path: ["SoftObjectPathsOffset"], before: 5022, after: 5058 },
    ];

    it("accepts the property, its names and the layout numbers that move", () => {
      expect(unexpectedChanges(rebuilt, [added])).toEqual({ unplanned: [], unapplied: [] });
    });

    it("still rejects any other change", () => {
      const other = { path: ["NameMap", 166], before: null, after: "SomethingElse" };
      const value = { path: ["Exports", 2, "Data", 3, "Value"], before: 1, after: 2 };

      expect(unexpectedChanges([...rebuilt, other, value], [added]).unplanned).toEqual([
        other,
        value,
      ]);
    });

    it("does not allow layout changes in an asset without an added property", () => {
      const layout = { path: ["Exports", 0, "SerialOffset"], before: 9434, after: 9470 };

      expect(unexpectedChanges([layout], [slots]).unplanned).toContainEqual(layout);
    });

    it("rejects an added property with another value", () => {
      const wrong = {
        path: ["Exports", 6, "Data", 0],
        before: null,
        after: { Name: "SlotNum", Value: 30 },
      };

      expect(unexpectedChanges([wrong], [added]).unapplied).toEqual([added]);
    });
  });

  it("reads the change list uasset-json prints", () => {
    const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(FieldChanges))(
      `[{"path":["Exports",1,"Data",304,"Value"],"before":54,"after":444}]`,
    );

    expect(
      unexpectedChanges(decoded, [{ ...slots, path: ["Exports", 1, "Data", 304, "Value"] }]),
    ).toEqual({ unplanned: [], unapplied: [] });
  });
});
