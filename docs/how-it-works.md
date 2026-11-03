# How it works

## The pack

The open-pal pack is one file, `OpenPal_P.pak`. It contains changed copies of some game data files. The server loads it after the game pak, so the changed values replace the vanilla values. The pack contains data only. It does not run code.

palforge builds the pack from the game files on your server. Thus the pack always starts from the current game data.

## Build and check

1. palctl reads the build number of the game on the server.
2. palctl makes sure that mappings exist for this build.
3. palctl gets the game files that the enabled features change.
4. palctl calculates the changes from your configuration and the vanilla values.
5. The modbuilder tool applies the changes and packs the files.
6. palctl reads the finished pack again. It compares each file with vanilla.

palctl refuses the pack if a value changed that the configuration does not ask for. Two builds with the same game build and the same configuration give the same bytes.

## Start-time guard

The server image updates the game when the server starts. A pack for an old game build can then be wrong for the new game.

The guard is a small script in the image `palforge/palworld-server`. It runs at each start, after the game update and before the server starts. It keeps the pack only if these conditions are true:

- The pack was built for the game build that is installed.
- The pack has the same SHA-256 as its manifest.

If a condition is false, the guard moves the pack to `open-pal-disabled/` in the game volume. The server then starts vanilla. Refer to [server-image](../tools/server-image/README.md).

## Game updates

`palctl update` downloads a new game build next to the running server. It builds the pack for the new build before it stops the server. While the server is stopped, palctl copies the game files first and the Steam manifest last. If the copy stops before the end, the manifest still shows the old build, and the server image downloads the update again at the next start.

## Rollback

If a deploy fails after the server stops, palctl removes the pack and starts the server again. Then it checks the server again.

## Files on the server host

| Path                         | Content                                    |
| ---------------------------- | ------------------------------------------ |
| `<workDir>/mappings/`        | One `.usmap` file for each game build      |
| `<workDir>/mappings-dumper/` | The Windows server that makes the mappings |
| `<workDir>/packs/`           | One directory for each pack build          |
| `<workDir>/staging/`         | The last staged game build, about 5 GB     |
| `<workDir>/saves/`           | One directory for each save edit           |
| `<workDir>/events/`          | The events of the last `event sync`        |
| `Pal/Content/Paks/~mods/`    | The installed pack and its manifest        |
| `open-pal-disabled/`         | Packs that the guard refused               |
