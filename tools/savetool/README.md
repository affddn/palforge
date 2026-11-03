# savetool

A pinned image that reads and edits a stopped Palworld world with `palsav` from [PalworldSaveTools](https://github.com/deafdudecomputers/PalworldSaveTools) v2.4.5. palctl builds it on each server host and runs it with `--network none`. Refer to [save edits](../../docs/save-edits.md) for the plan format.

- The base image is pinned by digest, the Python packages by hash, and PalworldSaveTools by commit.
- `palsav` and its Oodle bindings (`palooz`) are GPL-3.0. The image downloads them when it is built; this repository does not include them.

```bash
docker build -t palforge-savetool tools/savetool
```

## Commands

The world directory holds `Level.sav` and `Players/`. Always use a copy, not the live world.

```bash
savetool show <world> <player>
savetool apply <world> <plan.json> <out>
savetool verify <world> <out>/report.json
```

- `show` prints the party, the Palbox, the Dimensional Pal Storage (DPS) and the inventory of a player as JSON.
- `apply` writes the changed save files to `<out>`, with `report.json`: the changes, the changed files, and what each change must leave in the world. The `from` of `restoreContainer` must be a `Level.sav` that savetool can read.
- `verify` checks a world that the server saved after the edit against `report.json`.

A refusal exits with 1 and gives the reason on stderr.

## Checks

- Each file must write back byte for byte before an edit. Data that palsav does not understand would be lost, so a new save format stops all edits.
- `apply` collects the broken references in the world before and after the plan. A new one stops the edit.
- `apply` reads each written file again and compares it with the original. Only the Pals, DPS entries, containers, guild handles and dynamic item records that the plan touched can differ. A touched Pal can change only its `SlotId`, a container only its slots, and a guild only the handles of touched Pals.
- A Pal that moves between `Level.sav` and DPS must have the same fields in both, apart from `SlotId`. `Level.sav` saves only the fields that differ from an empty DPS entry. A Pal goes to DPS only if nothing else in `Level.sav`, such as an expedition, refers to it.
- The written file keeps the compression of the original (PlM, Oodle, on game v1.0).

`apply` takes about 35 seconds for a 2 MB `Level.sav` on a 4-core host: palsav reads the world three times. A DPS file is about 70 MB unpacked, so savetool reads one only when an operation needs it, and checks the written files one at a time to stay within the 4 GB memory limit.
