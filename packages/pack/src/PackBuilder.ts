import { createHash } from "node:crypto";
import { ensureContextImage, RemoteShell } from "@palforge/core";
import type { Server } from "@palforge/core";
import { dumpMappings, installedBuild } from "@palforge/mappings";
import { modbuilderContext } from "@palforge/modbuilder";
import { FieldChanges, OpenPalConfig, recipeFor, unexpectedChanges } from "@palforge/open-pal";
import type { FieldChange, FieldEdit } from "@palforge/open-pal";
import { Effect, Option, Schema } from "effect";

export const packFile = "OpenPal_P.pak";

export class PackBuildFailed extends Schema.TaggedError<PackBuildFailed>()("PackBuildFailed", {
  server: Schema.String,
  message: Schema.String,
}) {}

// Written next to every pak, so a deploy or a person can tell what it changes and what it was built from.
export class PackManifest extends Schema.Class<PackManifest>("@palforge/pack/PackManifest")({
  gameBuildId: Schema.String,
  buildHash: Schema.String,
  toolchain: Schema.String,
  config: OpenPalConfig,
  pakSha256: Schema.String,
  assets: Schema.Array(
    Schema.Struct({
      asset: Schema.String,
      features: Schema.Array(Schema.String),
      edits: Schema.Array(
        Schema.Struct({
          label: Schema.String,
          kind: Schema.Literals(["int", "float", "bool"]),
          from: Schema.Union([Schema.Number, Schema.Boolean, Schema.Null]),
          to: Schema.Union([Schema.Number, Schema.Boolean]),
        }),
      ),
    }),
  ),
}) {}

export interface BuiltPack {
  readonly dir: string;
  readonly pak: string;
  readonly manifest: PackManifest;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// Both scripts run in the toolchain container with /work as the build directory and the asset paths as arguments.
const extractScript = `set -eu
for asset in "$@"; do
  repak unpack -q -f -o vanilla -i "$asset.uasset" -i "$asset.uexp" /game/Pal-LinuxServer.pak
  mkdir -p "json/vanilla/$(dirname "$asset")"
  uasset-json tojson "vanilla/$asset.uasset" "json/vanilla/$asset.json" /mappings.usmap
done`;

// Packs the edited assets, then extracts them from the finished pak again so the check sees what the server will load.
const buildScript = `set -eu
for asset in "$@"; do
  mkdir -p "json/edited/$(dirname "$asset")" "OpenPal_P/$(dirname "$asset")"
  uasset-json edit "json/vanilla/$asset.json" "edits/$asset.json" "json/edited/$asset.json"
  uasset-json fromjson "json/edited/$asset.json" "OpenPal_P/$asset.uasset" /mappings.usmap
done
# repak writes entries in parallel, so with more than one thread their order, and the pak's bytes, vary run to run.
RAYON_NUM_THREADS=1 repak pack -q --version V11 OpenPal_P ${packFile}
for asset in "$@"; do
  repak unpack -q -f -o rebuilt -i "$asset.uasset" -i "$asset.uexp" ${packFile}
  mkdir -p "json/rebuilt/$(dirname "$asset")" "changes/$(dirname "$asset")"
  uasset-json tojson "rebuilt/$asset.uasset" "json/rebuilt/$asset.json" /mappings.usmap
  uasset-json diff "json/vanilla/$asset.json" "json/rebuilt/$asset.json" > "changes/$asset.json"
done
sha256sum ${packFile}`;

const describeRejection = (
  asset: string,
  unplanned: ReadonlyArray<FieldChange>,
  unapplied: ReadonlyArray<FieldEdit>,
) =>
  [
    `The rebuilt ${asset} does not match the recipe:`,
    ...unplanned.map(
      (change) =>
        `  changed outside the recipe: ${change.path.join(".")} ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`,
    ),
    ...unapplied.map((edit) => `  not applied: ${edit.label} -> ${edit.to}`),
  ].join("\n");

// A game install on the server's host to build from: its root directory (the one holding `Pal/` and `steamapps/`)
// and its Steam build.
export interface GameFiles {
  readonly root: string;
  readonly buildId: string;
}

// The game install the server's container runs, from the volume it mounts at /palworld.
export const liveGameFiles = Effect.fn("liveGameFiles")(function* (server: Server) {
  const shell = yield* RemoteShell;

  const root = (yield* shell.run(server, [
    "docker",
    "inspect",
    "-f",
    '{{range .Mounts}}{{if eq .Destination "/palworld"}}{{.Source}}{{end}}{{end}}',
    server.container,
  ])).trim();

  if (root === "") {
    return yield* new PackBuildFailed({
      server: server.name,
      message: `${server.container} has no volume mounted at /palworld`,
    });
  }

  return { root, buildId: yield* installedBuild(server) } satisfies GameFiles;
});

// Builds OpenPal_P.pak on the server's host from its own game files, or from `game` when given (a staged update);
// none when every feature is off.
export const buildPack = Effect.fn("buildPack")(function* (
  server: Server,
  config: OpenPalConfig,
  game?: GameFiles,
) {
  const recipes = yield* recipeFor(config);

  if (recipes.length === 0) {
    return Option.none<BuiltPack>();
  }

  const shell = yield* RemoteShell;
  const failed = (message: string) => new PackBuildFailed({ server: server.name, message });

  const onHost = (script: string, ...args: ReadonlyArray<string>) =>
    shell.run(server, ["sh", "-c", script, "sh", ...args]);

  const upload = (path: string, content: string) =>
    shell.run(
      server,
      ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path],
      content,
    );

  const readJson = <A>(schema: Schema.Codec<A>, path: string) =>
    onHost('cat "$1"', path).pipe(
      Effect.flatMap((text) => Schema.decodeEffect(Schema.fromJsonString(schema))(text)),
      Effect.mapError((cause) =>
        cause instanceof Schema.SchemaError ? failed(`${path}: ${cause.message}`) : cause,
      ),
    );

  const files = game ?? (yield* liveGameFiles(server));
  const mappings = yield* dumpMappings(server, files.buildId);

  const image = yield* ensureContextImage(server, "modbuilder", modbuilderContext).pipe(
    Effect.mapError((cause) => failed(cause.message)),
  );

  const assets = [...new Set(recipes.map((recipe) => recipe.asset))].toSorted();

  // Same game build, config and toolchain give the same directory, and the same pak bytes.
  const buildHash = sha256(
    JSON.stringify({
      gameBuildId: mappings.buildId,
      config: Schema.encodeSync(OpenPalConfig)(config),
      toolchain: image,
    }),
  ).slice(0, 12);

  const dir = `${server.workDir}/packs/${mappings.buildId}-${buildHash}`;

  const inToolchain = (script: string) =>
    onHost(
      `image="$1" pak="$2" usmap="$3" dir="$4"
shift 4
exec docker run --rm --network none --memory 3g -v "$pak:/game/Pal-LinuxServer.pak:ro" \\
  -v "$usmap:/mappings.usmap:ro" -v "$dir:/work" -w /work "$image" "$@"`,
      image,
      `${files.root}/Pal/Content/Paks/Pal-LinuxServer.pak`,
      mappings.path,
      dir,
      "sh",
      "-c",
      script,
      "sh",
      ...assets,
    );

  yield* onHost('rm -rf "$1" && mkdir -p "$1"', dir);
  yield* inToolchain(extractScript);

  const planned = yield* Effect.forEach(assets, (asset) =>
    Effect.gen(function* () {
      const vanilla = yield* readJson(Schema.Json, `${dir}/json/vanilla/${asset}.json`);
      const forAsset = recipes.filter((recipe) => recipe.asset === asset);
      const edits = (yield* Effect.forEach(forAsset, (recipe) => recipe.edits(vanilla))).flat();

      yield* upload(
        `${dir}/edits/${asset}.json`,
        JSON.stringify(
          edits.map((edit) =>
            edit.insert === undefined
              ? { path: edit.path, value: edit.to }
              : {
                  path: edit.path.slice(0, -2),
                  append: edit.insert.property,
                  names: edit.insert.names,
                },
          ),
        ),
      );

      return { asset, features: forAsset.map((recipe) => recipe.feature), edits };
    }),
  );

  const pakSha256 = (yield* inToolchain(buildScript)).trim().split(/\s+/u)[0] ?? "";

  yield* Effect.forEach(planned, ({ asset, edits }) =>
    Effect.gen(function* () {
      const changes = yield* readJson(FieldChanges, `${dir}/changes/${asset}.json`);
      const { unplanned, unapplied } = unexpectedChanges(changes, edits);

      // A rejected pak is deleted so nothing unchecked is left where a deploy could find it.
      if (unplanned.length > 0 || unapplied.length > 0) {
        yield* onHost('rm -f "$1"', `${dir}/${packFile}`);

        return yield* failed(describeRejection(asset, unplanned, unapplied));
      }
    }),
  );

  const manifest = new PackManifest({
    gameBuildId: mappings.buildId,
    buildHash,
    toolchain: image,
    config,
    pakSha256,
    assets: planned.map(({ asset, features, edits }) => ({
      asset,
      features,
      edits: edits.map(({ label, kind, from, to }) => ({ label, kind, from, to })),
    })),
  });

  yield* upload(
    `${dir}/manifest.json`,
    JSON.stringify(Schema.encodeSync(PackManifest)(manifest), null, 2),
  );

  return Option.some({ dir, pak: `${dir}/${packFile}`, manifest } satisfies BuiltPack);
});
