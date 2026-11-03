# server-image

`palforge/palworld-server` is the operator's own Palworld server image plus the open-pal start-time guard. `palctl pack deploy` builds it on each host, `FROM` the exact digest of the server's `upstreamImage` (default `thijsvanloef/palworld-server-docker:latest`), and tags it `palforge/palworld-server:current`.

The image updates the game inside its own `start.sh` and then launches the server, with no hook in between. The guard is therefore inserted into `start.sh` right before `LogAction "Starting Server"`. That way it runs at every start (compose, restart policies, the image's own update restarts) and always after any game update. If a future upstream `start.sh` lacks that line, the build fails and the server keeps the image it has.

`open-pal-guard.sh` checks `~mods/OpenPal_P.pak` against `OpenPal_P.manifest.json`:

- The manifest's `gameBuildId` must equal the installed `steamapps/appmanifest_2394010.acf` build ID.
- The pak's SHA-256 must equal the manifest's `pakSha256`.

Otherwise the guard moves both files to `/palworld/open-pal-disabled/<UTC time>/` and the server starts vanilla. That directory must stay outside `Pal/Content/Paks`, because the engine mounts every `.pak` anywhere under it, subdirectories included. A refused pak left there was still loaded and crashed the canary once during M3 testing.

The image's log pipeline adds a timestamp to the guard's lines and upper-cases their tag:

```
[2026-11-02 18:43:57] [OPEN-PAL] OpenPal_P.pak matches game build 25247047
```
