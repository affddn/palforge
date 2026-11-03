import { Effect, Schema } from "effect";
import {
  dataTableFlags,
  dataTableNumbers,
  exportNumber,
  exportNumberEdit,
} from "#src/AssetJson.ts";
import type { FieldEdit, NumberKind, RecipeTargetMissing } from "#src/AssetJson.ts";
import type { OpenPalConfig } from "#src/OpenPalConfig.ts";

// One game asset an enabled feature edits, named by its path in the game pak without the extension.
export interface AssetRecipe {
  readonly feature: string;
  readonly asset: string;
  edits(vanilla: Schema.Json): Effect.Effect<ReadonlyArray<FieldEdit>, RecipeTargetMissing>;
}

const content = (path: string) => `Pal/Content/Pal/${path}`;

export const gameSettingsAsset = content("Blueprint/System/BP_PalGameSetting");

export const expeditionsAsset = content(
  "DataTable/CharacterTeamMission/DT_CharacterTeamMissionDataTable",
);

const gameSettings = "Default__BP_PalGameSetting_C";
const chestParameter = "PalMapObjectItemChestParameter_GEN_VARIABLE";

// The largest container the game itself builds is the guild chest, which open-pal already raises to 444.
const maxContainerSlots = 444;

const chests = [
  "Blueprint/MapObject/BuildObject/BP_BuildObject_ItemChest_02",
  "Blueprint/MapObject/BuildObject/BP_BuildObject_ItemChest_03",
  "Blueprint/MapObject/BuildObject/BP_BuildObject_ItemChest_04",
].map(content);

// Food containers and the component that holds their slot count. The Feed Box keeps the code default, so its slot
// count is added rather than changed.
const foodContainers = [
  {
    path: "Blueprint/MapObject/BuildObject/BP_BuildObject_PalFoodBox",
    component: "FoodBoxParameter_GEN_VARIABLE",
  },
  {
    path: "Blueprint/MapObject/BuildObject/BP_BuildObject_PalFoodBoxCool",
    component: "FoodBoxParameter_GEN_VARIABLE",
  },
  {
    path: "Blueprint/MapObject/BuildObject/BP_BuildObject_Refrigerator",
    component: chestParameter,
  },
];

// Int properties hold whole numbers, and no duration, amount or count drops below 1.
const scale = (value: number, multiplier: number, kind: NumberKind) =>
  kind === "int" ? Math.max(1, Math.round(value * multiplier)) : Math.max(1, value * multiplier);

type Edits = Effect.Effect<ReadonlyArray<FieldEdit>, RecipeTargetMissing>;

// Sets one number on one export to a fixed value; adds it when the game keeps it at its code default.
const exportSet = (
  vanilla: Schema.Json,
  exportName: string,
  property: string,
  kind: NumberKind,
  value: number,
): Edits =>
  exportNumberEdit(vanilla, exportName, property, kind, () => value).pipe(
    Effect.map((edit) => [edit]),
  );

// Scales one number on one export from its vanilla value, which the asset must hold.
const exportEdit = (
  vanilla: Schema.Json,
  exportName: string,
  property: string,
  kind: NumberKind,
  to: (from: number) => number,
): Edits =>
  exportNumber(vanilla, exportName, property, kind).pipe(
    Effect.map((field) => [
      {
        label: `${exportName}.${property}`,
        kind,
        path: field.path,
        from: field.value,
        to: to(field.value),
      },
    ]),
  );

// The same number in every row of a DataTable, each set from its vanilla value.
const rowEdits = (
  vanilla: Schema.Json,
  property: string,
  kind: NumberKind,
  to: (from: number) => number,
): Edits =>
  dataTableNumbers(vanilla, property, kind).pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        label: `${row.row}.${property}`,
        kind,
        path: row.path,
        from: row.value,
        to: to(row.value),
      })),
    ),
  );

const together = (...parts: ReadonlyArray<Edits>): Edits =>
  Effect.all(parts).pipe(Effect.map((edits) => edits.flat()));

const recipesFor = (config: OpenPalConfig): ReadonlyArray<AssetRecipe | undefined> => [
  config.guildChest.enabled
    ? {
        feature: "guildChest",
        asset: gameSettingsAsset,
        edits: (vanilla) =>
          exportSet(vanilla, gameSettings, "GuildChestSlotNum", "int", config.guildChest.slots),
      }
    : undefined,

  config.expeditions.enabled
    ? {
        feature: "expeditions",
        asset: expeditionsAsset,
        edits: (vanilla) =>
          rowEdits(vanilla, "RequiredSeconds", "int", (seconds) =>
            scale(seconds, config.expeditions.durationMultiplier, "int"),
          ),
      }
    : undefined,

  config.breeding.enabled
    ? {
        feature: "breeding",
        asset: content("Blueprint/MapObject/BuildObject/BP_BuildObject_BreedFarm"),
        edits: (vanilla) =>
          exportEdit(
            vanilla,
            "BreedFarmParameter_GEN_VARIABLE",
            "BreedRequiredRealTime",
            "float",
            (seconds) => scale(seconds, config.breeding.timeMultiplier, "float"),
          ),
      }
    : undefined,

  config.palboxRest.enabled
    ? {
        feature: "palboxRest",
        asset: gameSettingsAsset,
        edits: (vanilla) =>
          exportEdit(
            vanilla,
            gameSettings,
            "AutoSANRegene_Percent_perSecond_PalStorage",
            "float",
            (rate) => rate * config.palboxRest.sanityRegenMultiplier,
          ),
      }
    : undefined,

  config.palboxRest.enabled
    ? {
        feature: "palboxRest",
        asset: content("DataTable/BaseCamp/DT_BaseCampWorkerSickDataTable"),
        // A probability, so the scaled chance stops at 100%; a sickness with no chance (0) stays at 0.
        edits: (vanilla) =>
          rowEdits(vanilla, "RecoveryProbabilityPercentageInPalBox", "int", (percent) =>
            Math.min(100, Math.round(percent * config.palboxRest.sickRecoveryMultiplier)),
          ),
      }
    : undefined,

  config.calmWorkers.enabled
    ? {
        feature: "calmWorkers",
        asset: content("DataTable/BaseCamp/DT_BaseCampWorkerEventDataTable"),
        edits: (vanilla) =>
          dataTableFlags(vanilla, "Invalid").pipe(
            Effect.map((rows) =>
              rows
                .filter((row) =>
                  config.calmWorkers.disabledEvents.some((event) => event === row.row),
                )
                .map((row): FieldEdit => ({
                  label: `${row.row}.Invalid`,
                  kind: "bool",
                  path: row.path,
                  from: row.value,
                  to: true,
                })),
            ),
          ),
      }
    : undefined,

  config.calmWorkers.enabled
    ? {
        feature: "calmWorkers",
        asset: gameSettingsAsset,
        edits: (vanilla) =>
          exportSet(
            vanilla,
            gameSettings,
            "BaseCampWorkerEventTriggerProbability",
            "float",
            config.calmWorkers.triggerProbability,
          ),
      }
    : undefined,

  config.crops.enabled
    ? {
        feature: "crops",
        asset: content("DataTable/MapObject/DT_MapObjectFarmCrop"),
        edits: (vanilla) =>
          together(
            rowEdits(vanilla, "GrowupTime", "float", (seconds) =>
              scale(seconds, config.crops.growthMultiplier, "float"),
            ),
            ...["SeedingWorkAmount", "WateringWorkAmount", "HarvestWorkAmount"].map((property) =>
              rowEdits(vanilla, property, "float", (work) =>
                scale(work, config.crops.workMultiplier, "float"),
              ),
            ),
          ),
      }
    : undefined,

  ...chests.map((asset): AssetRecipe | undefined =>
    config.storage.enabled
      ? {
          feature: "storage",
          asset,
          edits: (vanilla) =>
            exportEdit(vanilla, chestParameter, "SlotNum", "int", (slots) =>
              Math.min(maxContainerSlots, slots * config.storage.slotMultiplier),
            ),
        }
      : undefined,
  ),

  ...foodContainers.map(({ path, component }): AssetRecipe | undefined =>
    config.foodStorage.enabled
      ? {
          feature: "foodStorage",
          asset: content(path),
          edits: (vanilla) =>
            exportSet(vanilla, component, "SlotNum", "int", config.foodStorage.slots),
        }
      : undefined,
  ),

  config.labResearch.enabled
    ? {
        feature: "labResearch",
        asset: content("DataTable/Lab/DT_LabResearchDataTable"),
        edits: (vanilla) =>
          rowEdits(vanilla, "RequiredWorkAmount", "int", (work) =>
            scale(work, config.labResearch.workMultiplier, "int"),
          ),
      }
    : undefined,

  config.techPoints.enabled
    ? {
        feature: "techPoints",
        asset: gameSettingsAsset,
        edits: (vanilla) =>
          exportSet(
            vanilla,
            gameSettings,
            "technologyPointPerLevel",
            "int",
            config.techPoints.pointsPerLevel,
          ),
      }
    : undefined,
];

// The asset edits for every enabled feature. A feature can edit several assets, and several features can edit
// one asset; the builder applies all edits to an asset together.
export const recipeFor = (config: OpenPalConfig) =>
  Effect.succeed(recipesFor(config).filter((recipe) => recipe !== undefined));
