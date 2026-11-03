# Features

Each feature is off until you enable it in the open-pal configuration. See [Configuration](configuration.md#qol-features). All features were built and checked on game build 25247047 (v1.0.5).

| Feature                  | Key           | Settings: default (range)                                                               |
| ------------------------ | ------------- | --------------------------------------------------------------------------------------- |
| Guild chest slots        | `guildChest`  | `slots`: 444 (54 to 960)                                                                |
| Chest slots              | `storage`     | `slotMultiplier`: 2 (1 to 4), never more than 444 slots                                 |
| Food container slots     | `foodStorage` | `slots`: 444 (50 to 444)                                                                |
| Expedition time          | `expeditions` | `durationMultiplier`: 0.25 (0.05 to 1)                                                  |
| Breeding Farm time       | `breeding`    | `timeMultiplier`: 0.5 (0.1 to 1)                                                        |
| Palbox rest and recovery | `palboxRest`  | `sanityRegenMultiplier`: 4 (1 to 10), `sickRecoveryMultiplier`: 2 (1 to 5)              |
| Calm base workers        | `calmWorkers` | `disabledEvents`: TurnFoodBox, EatTooMuch, Trantrum; `triggerProbability`: 50 (0 to 50) |
| Crop growth              | `crops`       | `growthMultiplier`: 0.5 (0.1 to 1), `workMultiplier`: 0.5 (0.25 to 1)                   |
| Lab research             | `labResearch` | `workMultiplier`: 0.5 (0.25 to 1)                                                       |
| Technology points        | `techPoints`  | `pointsPerLevel`: 8 (6 to 12)                                                           |

## What each feature changes

| Feature                  | Game data                                                                                                                                    | Vanilla                                                        | Stays in the save when you disable it                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Guild chest slots        | `BP_PalGameSetting`: `GuildChestSlotNum`                                                                                                     | 54                                                             | Yes. A chest keeps its slot count.                                          |
| Chest slots              | `SlotNum` in the metal, stone and large chests                                                                                               | 24, 40, 54                                                     | Yes. Each container keeps its slot count. The wooden chest does not change. |
| Food container slots     | `SlotNum` in the Feed Box, the Cold Food Box and the fridge                                                                                  | Feed Box: the game's code default; Cold Food Box 30; fridge 25 | Yes. Each container keeps its slot count.                                   |
| Expedition time          | `DT_CharacterTeamMissionDataTable`: `RequiredSeconds`                                                                                        | 1,800 to 7,200 s                                               | No                                                                          |
| Breeding Farm time       | `BP_BuildObject_BreedFarm`: `BreedRequiredRealTime`                                                                                          | 300 s                                                          | No                                                                          |
| Palbox rest and recovery | `BP_PalGameSetting`: `AutoSANRegene_Percent_perSecond_PalStorage`; `DT_BaseCampWorkerSickDataTable`: `RecoveryProbabilityPercentageInPalBox` | 2% per second; 3% to 20% per check                             | No                                                                          |
| Calm base workers        | `DT_BaseCampWorkerEventDataTable`: `Invalid`; `BP_PalGameSetting`: `BaseCampWorkerEventTriggerProbability`                                   | Events on; 50%                                                 | No                                                                          |
| Crop growth              | `DT_MapObjectFarmCrop`: `GrowupTime` and the seeding, watering and harvest work                                                              | 180 to 390 s                                                   | No. A plot that was already planted can keep its old time.                  |
| Lab research             | `DT_LabResearchDataTable`: `RequiredWorkAmount`                                                                                              | Each research's own value                                      | Yes. Finished research stays finished.                                      |
| Technology points        | `BP_PalGameSetting`: `technologyPointPerLevel`                                                                                               | 6                                                              | Yes. Players keep the points that they got.                                 |

The Feed Box does not store its slot count in its game data. palforge adds the field to the pack. The build check accepts only this field, its two names and the file positions that move because of it.

The server decides all these values, so players do not install mods. Some screens on the player's console can still show the vanilla number. For example, the Breeding Farm countdown can show 300 seconds.
