# Runbook

Use this page when palctl reports a failure. palctl puts each server back to a safe state before it reports a failure: the server runs, and it runs vanilla if the pack is the problem. Thus you have time to find the cause.

## First steps

1. Read the last line of the palctl output. It gives the server, the step and the cause.
2. Run `palctl status <server>`. Make sure that the server runs and has a good FPS.
3. Do not edit `PalWorldSettings.ini` or the files in `~mods` while the server runs.

To make a server vanilla now, deploy with no features:

```bash
PALFORGE_OPEN_PAL='{}' bun apps/palctl/src/main.ts pack deploy <server>
```

If palctl cannot connect, do it by hand on the server host: `docker compose stop`, delete `Pal/Content/Paks/~mods/OpenPal_P.pak` and `OpenPal_P.manifest.json`, then `docker compose up -d`.

## After a game update

The server image updates the game when the server starts. Then the [start-time guard](how-it-works.md#start-time-guard) moves the pack to `open-pal-disabled/` and the server starts vanilla. The server log shows `[OPEN-PAL] Moved OpenPal_P.pak aside`.

`palctl update` does nothing in this case, because the server already has the latest build. Build the pack for the new build:

```bash
bun apps/palctl/src/main.ts pack deploy <server>
```

## palctl update

Each failure names its step. palctl stops at the failed step. The servers that palctl did not update continue with their build.

| Step     | Message                                                    | What to do                                                                                                                                                                                                 |
| -------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| detect   | `steamcmd printed no public build ID`, or a steamcmd error | Steam or the network has a problem. Try again later.                                                                                                                                                       |
| stage    | `steamcmd did not install the game; see <log>`             | Read the log on the server host. For `Missing configuration`, try again. For a full disk, make space with `df -h` and `docker system df`.                                                                  |
| stage    | `Steam served build X while build Y was being staged`      | Steam released a newer build during the update. Run the update again.                                                                                                                                      |
| mappings | `The dumper exited without writing mappings`               | Read `docker logs palforge-mappings-dumper`. If UE4SS does not support the new build, refer to [Mappings](#mappings).                                                                                      |
| build    | A feature, an asset and a path that do not exist           | The game changed an asset of a feature. Refer to [A feature does not build](#a-feature-does-not-build).                                                                                                    |
| build    | `does not reproduce its export data`                       | The mappings do not agree with the game build. Delete `<workDir>/mappings/<build>.usmap` on the server host and run the update again. If it fails again, refer to [Mappings](#mappings).                   |
| switch   | `Rolled back to vanilla; <server> is healthy`              | The server runs the new build, or its old build, without the pack. Run `palctl status <server>`. Then read the server log near `[OPEN-PAL]` and run `palctl pack deploy <server>` when you know the cause. |
| soak     | `Rolled back to vanilla`                                   | The canary did not stay healthy with the pack on the new build. The other servers did not update. Keep the canary vanilla, and examine the FPS and the crash log before you deploy again.                  |

## A feature does not build

A game update can rename, move or remove a value that a feature changes.

1. Disable the feature for all servers in the open-pal configuration, for example `"crops": { "enabled": false }`.
2. Run `palctl update --all`. The servers get the new build with the other features.
3. Correct the recipe of the feature. Refer to [Add a feature](adding-a-feature.md). Add the new build to `checkedOn` only after you test the feature on the canary.
4. Enable the feature again and run `palctl pack deploy` on the canary first.

## Mappings

Only some assets need mappings, for example `BP_PalGameSetting` (guild chest, Palbox rest, calm base workers and technology points). The dumper runs UE4SS from the Okaetsu build. After a large game update, UE4SS can stop working until a new build is released.

- Until then, disable the features that need mappings. Each failure gives the asset.
- When a new UE4SS build is released, change `ue4ssUrl` in `packages/mappings/src/MappingsDumper.ts` and run `palctl mappings <canary>`.

## Save edits

| Message                                              | What to do                                                                                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `palsav does not write this file back byte for byte` | A game update changed the save format. Do not edit saves. When PalworldSaveTools supports the new format, change `SAVE_TOOLS_COMMIT` in `tools/savetool/Dockerfile`. |
| `the edit would break the save`                      | The plan makes a broken reference. Read the list, correct the plan and try it with `--dry-run`.                                                                      |
| `Rolled back to the saves from before the edit`      | The server did not keep the edit, or did not start well with it. The original files are in `<workDir>/saves/<time>/original`.                                        |

## Events

If `palctl event sync` shows `the last deploy of these settings failed`, the server runs vanilla. Correct the event or the configuration. Then sync deploys the new settings. Or run `palctl pack deploy <server>`.

## Files on the server host

[How it works](how-it-works.md#files-on-the-server-host) lists the files that palctl keeps on the server host. `<workDir>` is `/srv/palforge` unless your server list sets it. The world backups are where the server image keeps them, and where your `backupCommand` copies them.
