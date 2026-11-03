# Commands

Run palctl from the repository root:

```bash
bun apps/palctl/src/main.ts <command>
```

All commands that use a server connect to it with SSH. The server name comes from your [server list](configuration.md#servers).

## status

`palctl status <server>` shows the game version, the players, the FPS and the uptime.

## assets

`palctl assets <server> [--match <text>]` lists the files in the game pak of the server. Use `--match` to show only the paths that contain the text. palctl reads only the index of the pak, approximately 12 MB.

## mappings

`palctl mappings <server>` makes sure that the server host has `.usmap` mappings for the game build of the server. palforge needs the mappings to read some game files. The first run downloads the Windows server, approximately 6 GB, and takes approximately 25 minutes. Then palctl keeps the files. A new game build takes approximately 1 minute. Refer to [mappings](../packages/mappings/README.md).

## pack features

`palctl pack features` shows each QoL feature, its settings and its vanilla value.

## pack build

`palctl pack build <server>` builds the pack on the server host from the game files of the server. palctl then reads the finished pack again. It refuses the pack if it changes a value that the configuration does not ask for. The result is `<workDir>/packs/<game build>-<hash>/OpenPal_P.pak` with a `manifest.json` file.

## pack deploy

`palctl pack deploy <server>` builds the pack and installs it. palctl does these steps:

1. If players are online, palctl announces the restart and waits 60 seconds.
2. palctl saves the world, makes a backup and runs `backupCommand`.
3. palctl stops the server.
4. palctl installs the pack. If all features are off, palctl removes the pack.
5. palctl starts the server and checks it. The server must be healthy, have the pack loaded and run at 20 FPS or more.

If a step fails after the server stops, palctl removes the pack, starts the server and checks it again.

Add `--wait-for-empty-minutes <minutes>` to wait for the players to leave before the announcement.

### Before the first deploy

The first deploy builds the image `palforge/palworld-server:current` on the server host. This image is your server image with the [start-time guard](how-it-works.md#start-time-guard). Then palctl stops and does not change the server.

Change the server service in your compose file to use this image:

```yaml
image: palforge/palworld-server:current
pull_policy: never
```

Then run `palctl pack deploy <server>` again.

### Update the server image

1. Pull the new image on the server host, for example `docker pull thijsvanloef/palworld-server-docker:latest`.
2. Run `palctl pack deploy <server>`.

palctl builds the guard into the new image and starts the server with it.

## save show

`palctl save show <server> <player>` lists the party, the Palbox and the inventory of a player, with the Pal IDs. The server continues to run. Refer to [save edits](save-edits.md).

## save edit

`palctl save edit <server> <plan> [--dry-run] [--wait-for-empty-minutes <minutes>]` applies a save plan: it moves Pals, sets a party or gives items. palctl stops the server for the edit. If a step fails, palctl puts back the original save files. Use `--dry-run` to see the changes on a copy first. Refer to [save edits](save-edits.md).

## party set

`palctl party set <server> <player> <pal...>` sets the party of an online player without a restart. It is an experiment and needs the [PalforgeLoadout](../tools/ue4ss-loadout/README.md) mod on a Windows (Wine) server. palctl refuses Pals that are not in the player's party or Palbox, and checks the party after the server saves. On a Linux server, use a `setParty` [save edit](save-edits.md).

## event list

`palctl event list` shows the events in the [configuration](configuration.md#events) and if each event is upcoming, running or ended.

## event sync

`palctl event sync <server>` or `palctl event sync --all` makes each server run its settings with the events that run now:

1. If the pack of the server is not the same as these settings, palctl deploys. The restart announcement gives the name of the event that starts or ends.
2. palctl shows the message of each event that starts. When an event ends, palctl tells the players.

If the pack is the same, palctl does not restart the server. Thus you can run the command every few minutes, for example with cron:

```text
*/5 * * * * cd /path/to/palforge && bun apps/palctl/src/main.ts event sync --all >> ~/palforge-events.log 2>&1
```

If a deploy fails, palctl puts the server back to vanilla and does not try the same settings again. Correct the configuration or deploy by hand. palctl keeps the state of each server in `<workDir>/events/<server>.json` on the server host.

## update

`palctl update <server>` updates the game on one server. `palctl update --all` updates all servers. palctl does these steps:

1. **detect**: palctl asks Steam for the latest build. If the server has it, palctl stops.
2. **stage**: palctl downloads the new build to `<workDir>/staging/`. The server continues to run.
3. **mappings**: palctl makes the mappings for the new build.
4. **build**: palctl builds the pack from the new game files.
5. **switch**: palctl deploys. While the server is stopped, palctl copies the new build into the server.

With `--all`, palctl updates the canary servers first. A canary must stay healthy for `--soak-minutes` (default 30). Then palctl updates the other servers. If a step fails, palctl stops. The servers that palctl did not update continue to run their build.

Before a restart, palctl waits up to `--wait-for-empty-minutes` (default 30) for the players to leave. Then it announces the restart.

Set `"canary": true` on a server in your [server list](configuration.md#servers) to make it a canary.

### Rehearse an update

`palctl update <server> --rehearse` does all the steps with the build that the server has now. Add `--fail-at <step>` to make a step fail on purpose. Use this to make sure that a failure leaves the server running.
