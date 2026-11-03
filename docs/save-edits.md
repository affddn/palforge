# Save edits

`palctl save edit` changes the saved world: it moves Pals between a party, a Palbox and Dimensional Pal Storage, sets a party, gives items, or puts back an item container from an older save. Use it for an arena loadout, or to fix a player's party, storage or items.

A running server keeps the world in memory. When it saves, it writes all save files again, also the files of players who are offline. Thus a change to a save file is lost if the server runs. palctl stops the server for each edit. The players lose nothing that the server saved before the stop.

## Find the IDs

`palctl save show <server> <player>` lists the party, the Palbox, the Dimensional Pal Storage (DPS) and the inventory of a player. Each Pal has an ID, and the inventory line shows the ID of the inventory container. The player is the name in the game or the player ID. The server continues to run.

```text
Ayla (1a2b3c4d-0000-0000-0000-000000000000)
Party (5):
    0  3f2a8c10-5b7e-4d21-9a6c-0e4b7d1f2a01  LegendDeer level 55
Palbox (957):
    0  7c41e9b2-0d3f-4a58-b6e7-2f9a1c3d4e02  BluePlatypus_Fire level 55
Dimensional Pal Storage (141):
    0  5d2e8f61-3a7b-4c90-8e1f-6b4a2c9d7e04  Penguin level 10
Inventory (16 stacks, container 6e1f0c3a-0000-4000-8000-000000000001):
    0  Money x740
```

## Write a plan

A plan is a JSON file with a list of operations. palctl does the operations in sequence.

```json
{
  "operations": [
    {
      "op": "setParty",
      "player": "Ayla",
      "pals": ["3f2a8c10-5b7e-4d21-9a6c-0e4b7d1f2a01", "7c41e9b2-0d3f-4a58-b6e7-2f9a1c3d4e02"]
    },
    { "op": "movePal", "pal": "a95d03f4-6e12-4b7c-8d90-3c5e7f1a2b03", "to": "dps" },
    { "op": "movePal", "pal": "5d2e8f61-3a7b-4c90-8e1f-6b4a2c9d7e04", "to": "palbox" },
    { "op": "giveItem", "player": "Ayla", "item": "Money", "count": 1000 },
    {
      "op": "restoreContainer",
      "container": "6e1f0c3a-0000-4000-8000-000000000001",
      "from": "/srv/backups/palworld-save-2026-01-01_06-00-00.tar.gz"
    }
  ]
}
```

| Operation          | Fields                                                      | Result                                                                                                |
| ------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `setParty`         | `player`, `pals` (0 to 5 IDs)                               | The party holds these Pals. The other party Pals go to the Palbox. Pals in the party keep their slot. |
| `movePal`          | `pal`, `to` (`party`, `palbox` or `dps`), `slot` (optional) | The Pal goes to the first free slot or DPS entry, or to `slot`.                                       |
| `giveItem`         | `player`, `item`, `count` (1 to 9999)                       | The items go on a stack of the same item, or in a free inventory slot.                                |
| `restoreContainer` | `container`, `from`                                         | The item container holds the same slots as in the older save `from`.                                  |

`giveItem` gives only items that some container in the world holds as a plain stack. Weapons, armor and eggs have their own item data, and palctl refuses them. This rule also stops a misspelled item.

### Dimensional Pal Storage

Each player has a DPS file, `Players/<player>_dps.sav`, with 9,600 entries. The game writes the file after the player uses the storage for the first time. palctl moves a Pal as the game does: `Level.sav` loses or gets the Pal, its slot in the party or Palbox, its entry in the guild and its entry in the list of Pals in storage (`InLockerCharacterInstanceIDArray`). The Pal keeps all its data.

`setParty` also takes Pals from DPS. palctl refuses these moves:

- A Pal that works at a base, or that something else in `Level.sav` refers to, for example an expedition. Move these Pals in the game.
- A Pal in a player's DPS that belongs to a different player.

### Restore a container

`from` is a path on the server host: a `Level.sav`, for example `original/Level.sav` of an earlier run, or an archive from the `backup` command of the server, in the `backups` folder of the game data. palctl copies the world's `Level.sav` from it into the run.

The container gets the slots of the older save. Items that came into the container after that save are lost, and items that went out of it come back. Do a dry run first: it shows each slot that changes.

Weapons, armor and eggs need a dynamic item record. Such an item keeps the record that the world has. If the world lost the record, the record of the older save comes back with the item. palctl refuses an item that is now in a different place in the world, because the item would then be in the world two times. palctl also refuses an older save from a different game version.

The inventory container of a player is in `palctl save show`. Other containers, such as chests, have IDs in `Level.sav` only.

## Try the plan

```bash
bun apps/palctl/src/main.ts save edit <server> plan.json --dry-run
```

palctl saves the world, applies the plan to a copy and shows each change. The server continues to run.

## Apply the plan

```bash
bun apps/palctl/src/main.ts save edit <server> plan.json --wait-for-empty-minutes 30
```

palctl does these steps:

1. palctl tries the plan on a copy. If the plan does not apply, palctl stops and does not restart the server.
2. palctl waits for the players to leave, announces the restart, saves the world, makes a backup and runs `backupCommand`.
3. palctl stops the server and applies the plan to the files that the server wrote when it stopped.
4. palctl starts the server and checks it.
5. palctl makes the server save. The saved files must still hold each change.

If a step fails after the server stops, palctl puts back the original files and starts the server.

palctl keeps each run on the server host in `<workDir>/saves/<time>`: `original/` (the files before the edit), `sources/` (the older saves of `restoreContainer`), `plan.json`, `candidate/` (the edited files and `report.json`) and `resaved/`. Delete old runs when you do not need them.

## Checks

palctl refuses an edit if one of these checks fails:

- The save tool must write each file back byte for byte before it changes the file. If a game update changes the save format, palctl refuses all edits until the save tool supports the new format.
- Player save files must have an upper-case GUID name. The game does not load other names.
- The edit must not add a broken reference: a Pal ID that occurs two times, also in `Level.sav` and DPS, two Pals in one slot, a slot outside its container, a Pal that is not in the slot that it points to, a guild entry for a Pal that is not there, or an item without its dynamic item record.
- The edited `Level.sav` and DPS files must be the same as the originals, except for the Pals, DPS entries, containers, guild entries and item records that the plan changes. A Pal can change only its slot. A Pal that moves to or from DPS must keep all its other data.

The [save tool](../tools/savetool/README.md) does the checks.
