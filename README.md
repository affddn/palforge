# palforge

palforge adds quality-of-life (QoL) changes to Palworld dedicated servers. Players do not install mods. If a change fails, the server goes back to vanilla.

## What palforge does

- It builds a mod pack, **open-pal**, from the game files on your server.
- It installs the pack with a backup, a restart and a health check.
- At each server start, it disables the pack if the game changed after the pack was built.
- It edits saves with the same backup and restart: party, Palbox and items.

You select each QoL feature in one configuration file. Each feature is off until you enable it.

## Features

| Feature                  | Change                                                           |
| ------------------------ | ---------------------------------------------------------------- |
| Guild chest slots        | The guild chest gets up to 960 slots.                            |
| Chest slots              | New chests get up to 4 times the slots.                          |
| Food container slots     | New Feed Boxes, Cold Food Boxes and fridges get up to 444 slots. |
| Expedition time          | Pal expeditions take 5% to 100% of the vanilla time.             |
| Breeding Farm time       | Eggs come in 10% to 100% of the vanilla time.                    |
| Palbox rest and recovery | Pals in the Palbox recover sanity and health faster.             |
| Calm base workers        | You select the worker events that stop.                          |
| Crop growth              | Crops grow and farm work finishes faster.                        |
| Lab research             | Research needs less work.                                        |
| Technology points        | Players get more technology points for each level.               |

The [feature list](docs/features.md) gives the settings, the risks and the game builds each feature was tested on.

## Requirements

- A Palworld dedicated server on Linux, in the Docker image `thijsvanloef/palworld-server-docker`.
- SSH access to the server host, with permission to use Docker.
- [Bun](https://bun.sh) 1.4 and [Vite+](https://viteplus.dev) (`vp`) on your computer.

## Start

1. Clone this repository. Then run `vp install`.
2. Copy `.env.example` to `.env`.
3. Add your servers to `PALFORGE_SERVERS` in `.env`.
4. Run `bun apps/palctl/src/main.ts status <server>`. Make sure that palctl shows your server.
5. Enable the features that you want in `~/.config/palforge/open-pal.json`.
6. Run `bun apps/palctl/src/main.ts pack deploy <server>`.

The first deploy does not change the server. It tells you to change one line in your compose file. Read [Deploy a pack](docs/commands.md#pack-deploy) before you start.

## Documentation

- [Configuration](docs/configuration.md): servers and QoL features
- [Commands](docs/commands.md): all `palctl` commands
- [Save edits](docs/save-edits.md): change a party, the Palbox or the items of a player
- [How it works](docs/how-it-works.md): build, check, deploy and the start-time guard
- [Runbook](docs/RUNBOOK.md): what to do when palctl reports a failure
- [Development](docs/development.md): build, test and project structure
- [Add a feature](docs/adding-a-feature.md): from a game value to a tested feature

## Status

palforge is in development. The [roadmap](https://github.com/affddn/palforge/issues/2) shows the milestones. [Releases](https://github.com/affddn/palforge/releases) show what changed in each version.
