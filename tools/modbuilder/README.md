# modbuilder

A pinned image for building open-pal paks from the game's own assets:

- `repak` 0.2.3, with the Oodle 2.9.10 library it loads already in place, so it runs with `--network none`
- `uasset-json`, a small CLI on UAssetAPI 1.1.0 that converts a cooked UE 5.1 asset to JSON and back

Every download is checked against a SHA-256 hash, the base images are pinned by digest, and NuGet restores in locked mode.

```bash
docker build -t palforge-modbuilder tools/modbuilder
```

## Building a pak

The game pak and the mappings (from `palctl mappings`, named by Steam build ID) are mounted read-only and everything else happens in `/work`:

```bash
docker run --rm --network none \
  -v /srv/palworld/data/Pal/Content/Paks/Pal-LinuxServer.pak:/game/Pal-LinuxServer.pak:ro \
  -v /srv/palforge/mappings:/mappings:ro -v "$PWD/work:/work" palforge-modbuilder sh -c '
    A=Pal/Content/Pal/Blueprint/System/BP_PalGameSetting
    repak unpack -q -o vanilla -i $A.uasset -i $A.uexp /game/Pal-LinuxServer.pak
    uasset-json tojson vanilla/$A.uasset BP_PalGameSetting.json /mappings/25247047.usmap'
```

After editing the JSON, write the asset back into the pak's directory tree and pack it. The output argument of `repak pack` is the pak file, and the version must be given because repak defaults to V8B:

```bash
uasset-json fromjson BP_PalGameSetting.json OpenPal_P/$A.uasset /mappings/25247047.usmap
repak pack -q --version V11 OpenPal_P OpenPal_P.pak
```

The `_P` suffix gives the pak priority over the base game; the server mounts it from `Pal/Content/Paks/~mods/`.

## What `tojson` checks

`tojson` fails if UAssetAPI leaves an export unparsed, or if writing the parsed asset does not reproduce the original export data (`.uexp`) byte for byte. That is how mappings that do not match the game build show up. With mappings, UAssetAPI appends the type names of enum properties to the name map, so a written `.uasset` can be a few names longer than the original even with no edits. Nothing references those names.
