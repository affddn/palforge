# Configuration

palforge reads two configurations: your **servers** and your **QoL features**.

## Servers

palctl reads the server list from the first source that exists:

1. The file in `--servers <path>`
2. The JSON in the environment variable `PALFORGE_SERVERS`
3. The file in the environment variable `PALFORGE_SERVERS_FILE`
4. `$XDG_CONFIG_HOME/palforge/servers.json`, then `~/.config/palforge/servers.json`

Bun reads `.env` from the current directory. You can put `PALFORGE_SERVERS` in `.env`. Use `.env.example` as a template.

Each server has these fields:

| Field           | Required | Description                                                                        |
| --------------- | -------- | ---------------------------------------------------------------------------------- |
| `name`          | Yes      | The name that you use in palctl commands.                                          |
| `sshHost`       | Yes      | The SSH host or alias of the server host.                                          |
| `container`     | Yes      | The name of the Docker container that runs Palworld.                               |
| `worldGuid`     | Yes      | The GUID of the world.                                                             |
| `workDir`       | No       | The directory on the host for palforge files. Default: `/srv/palforge`.            |
| `upstreamImage` | No       | The server image. Default: `thijsvanloef/palworld-server-docker:latest`.           |
| `backupCommand` | No       | A host command that palctl runs after each backup, for example an off-site upload. |
| `canary`        | No       | `true` to update this server first with `palctl update --all`. Default: `false`.   |

Example:

```json
[
  {
    "name": "main",
    "sshHost": "palworld-main",
    "container": "palworld-server",
    "worldGuid": "0123456789ABCDEF0123456789ABCDEF",
    "backupCommand": "systemctl start palworld-r2-backup.service"
  }
]
```

palctl checks the server list each time it starts. If the list is missing or not correct, palctl stops and tells you why.

## QoL features

palctl reads the open-pal configuration from the first source that exists:

1. The JSON in the environment variable `PALFORGE_OPEN_PAL`
2. The file in the environment variable `PALFORGE_OPEN_PAL_FILE`
3. `open-pal.json` in the same directory as `servers.json`

If no configuration exists, all features are off and the server stays vanilla. If the configuration is not correct, palctl stops and tells you which setting is wrong.

Example:

```json
{
  "guildChest": { "enabled": true, "slots": 444 },
  "expeditions": { "enabled": true, "durationMultiplier": 0.25 }
}
```

### Settings for one server

Add a `servers` section to give a server different settings. palctl merges the settings of each feature with the shared settings. In this example, all servers get the guild chest, except `main`:

```json
{
  "guildChest": { "enabled": true, "slots": 444 },
  "servers": {
    "main": { "guildChest": { "enabled": false } }
  }
}
```

palctl checks the settings of each server every time. A key that palctl does not know, for example a spelling mistake, stops palctl.

To see the features, their values and their ranges, run `palctl pack features`. Use `--server <name>` to see the settings of one server. The [feature list](features.md) gives more data about each feature.

### Events

An event changes features for a fixed time, for example faster eggs for a weekend. Add an `events` section. Each event has a `start` and an `end` with a time zone, a `message` for the players, its `features`, and optionally the `servers` that run it. Without `servers`, all servers run the event.

```json
{
  "breeding": { "enabled": true, "timeMultiplier": 0.5 },
  "events": {
    "egg-weekend": {
      "start": "2026-11-07T00:00:00+08:00",
      "end": "2026-11-09T00:00:00+08:00",
      "message": "Egg weekend: eggs come four times as fast until Sunday midnight",
      "servers": ["canary"],
      "features": { "breeding": { "timeMultiplier": 0.25 } }
    }
  }
}
```

palctl merges the features of an event over the settings of the server, as it does for `servers`. Each command that deploys uses the events that run at that time. Run [`palctl event sync`](commands.md#event-sync) every few minutes to start and stop events on time. palctl checks every event, also an event that does not run now.
