# mappings

`dumpMappings(server)` makes sure the server's host has `.usmap` mappings for the game build the server runs, at `<workDir>/mappings/<steam buildid>.usmap`. UAssetAPI needs them for the few exports whose property types are not in the asset itself (for example the class defaults in `BP_PalGameSetting`). Most Palworld server assets use tagged properties and parse without them.

When the build has no mappings yet, it starts `thijsvanloef/palworld-server-docker:wine` as a throwaway container named `palforge-mappings-dumper`. That runs the Windows server under Wine with the Okaetsu UE4SS build, and a Lua mod calls `DumpUSMAP()` once the world has loaded. The container gets its own volume at `<workDir>/mappings-dumper`, no published ports, at most 4 GB of memory and 2 CPUs, and a lower CPU share than the live server.

- The first run downloads the Windows server (about 6 GB) and takes about 25 minutes. Later runs keep that install and only download the update.
- The dump is refused when the dumper's Steam build differs from the server's, or when the output does not start with the usmap magic and a version of at least 4.
- A failed run leaves the stopped container in place; `docker logs palforge-mappings-dumper` shows UE4SS's log.

Mappings dumped on 2026-11-02 for build 25247047 (v1.0.5.102999) gave the same JSON as an independently published 1.0.5 usmap for eight assets, including `DT_PalMonsterParameter`, `DT_WazaMasterLevel` and `DA_StaticItemDataAsset`. Every enum value resolved to a name. Two dumps of the same build differ in byte order but parse identically, so a pack never depends on which dump it was built with.

If a game update makes UE4SS crash while it dumps Blueprint types, change the Lua mod to `DumpUSMAP(false)`, which dumps native types only.
