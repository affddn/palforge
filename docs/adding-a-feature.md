# Add a feature

A feature changes values in the game data. Each feature has a setting in the open-pal configuration, a recipe and tests.

## 1. Find the value

1. Find the asset. For example, run `palctl assets <server> --match FoodBox`.
2. Make sure that the server decides the value. If the player's console calculates or checks the value, players do not see the change, or their game desyncs. Examples: movement, stamina, build placement, recipe costs and menus.
3. Get the asset as JSON on the server host. Use the modbuilder image: `repak unpack`, then `uasset-json tojson` with the mappings. Refer to [modbuilder](../tools/modbuilder/README.md).
4. Find the property, its export or DataTable rows, its type (`int`, `float` or `bool`) and the vanilla value.

If the asset does not contain the property, the game uses its code default. A recipe can add a property that has a fixed value. A recipe cannot scale a property that the asset does not contain.

## 2. Add the setting

In `packages/open-pal/src/OpenPalConfig.ts`:

1. Add a class with `enabled: off` and the settings. Give each setting a default and a range.
2. Add the class to `OpenPalConfig`.
3. Add the feature to `features`, with its title and vanilla value.

## 3. Add the recipe

In `packages/open-pal/src/Recipe.ts`, add a recipe for each asset that the feature changes. Use the helpers:

| Helper           | Use it to                                                              |
| ---------------- | ---------------------------------------------------------------------- |
| `exportSet`      | Set a property on an export to a fixed value. It can add the property. |
| `exportEdit`     | Calculate a property on an export from its vanilla value.              |
| `rowEdits`       | Calculate a property in each row of a DataTable.                       |
| `dataTableFlags` | Set a `bool` property in the DataTable rows that you select.           |

## 4. Add tests

In `packages/open-pal/tests/Recipe.test.ts`, add the asset to the fixtures with the vanilla values of the real asset. Then test the edits that the recipe makes.

## 5. Check on a server

1. Run `palctl pack build <server>` with the feature enabled. The build must pass the check against vanilla.
2. Run `palctl pack deploy <server>` on a test server. The server must be healthy.
3. Check the change in the game, also on a console.
4. Add the game build to `checkedOn` in `OpenPalConfig.ts`, and the feature to [Features](features.md).
