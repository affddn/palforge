# Development

## Commands

```bash
vp install        # install the dependencies
vp check          # format, lint and type check
vp test --run     # run all tests
vp run ready      # check, test, then build all packages
```

Run the tests from the repository root. Vitest in one package finds a second copy of `vite-plus/test` and fails.

## Rules

- In a package, import its own files with the `#src/*` alias. Do not use `../` paths.
- Each pull request title follows Conventional Commits. The title becomes the commit on `main`.
- Agent instructions are in `AGENTS.md`. Packages with a pitfall have their own `AGENTS.md`.

## Structure

| Path                     | Content                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `apps/palctl`            | The `palctl` command line tool                                     |
| `packages/core`          | The server list and the SSH connection                             |
| `packages/palworld-rest` | A client for the Palworld REST API                                 |
| `packages/open-pal`      | The QoL configuration and the changes that each feature makes      |
| `packages/unreal-pak`    | A reader for the file index of Unreal Engine pak files             |
| `packages/mappings`      | Makes `.usmap` mappings in a temporary Windows server              |
| `packages/maintenance`   | The announced, backed-up restart that deploys and save edits use   |
| `packages/pack`          | Builds, checks and deploys the pack                                |
| `packages/save`          | Shows and edits the saved world                                    |
| `tools/modbuilder`       | A Docker image with repak and UAssetAPI                            |
| `tools/server-image`     | The server image with the start-time guard                         |
| `tools/savetool`         | A Docker image with palsav that reads and edits saves              |
| `tools/ue4ss-loadout`    | An experimental UE4SS mod for live party changes on Wine servers   |
| `packages/anti-slop`     | Lint rules from [anti-slop](https://github.com/dmmulroy/anti-slop) |

## Build a binary

`vp run palctl#build` makes `apps/palctl/dist/palctl-linux-x64`, one file that contains Bun and palctl.

## Releases

palforge uses one version for the whole repository. The release configuration is in `.github/`. The version follows [Semantic Versioning](https://semver.org). It is below 1.0 while palforge is in development.

1. Each merge to `main` updates a release pull request. This pull request shows the next version and the changelog. The changelog is in [CHANGELOG.md](CHANGELOG.md).
2. Merge the release pull request to make a release. GitHub then gets a tag `vX.Y.Z` and a release.
3. CI attaches `palctl-linux-x64` to the release. CI also publishes the modbuilder image to `ghcr.io/affddn/palforge-modbuilder`.

The pull request titles give the version change: `feat` increases the minor version and `fix` increases the patch version. Before 1.0, a breaking change also increases only the minor version.
