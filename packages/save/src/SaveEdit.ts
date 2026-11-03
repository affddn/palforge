import { ensureContextImage, RemoteShell } from "@palforge/core";
import type { Server } from "@palforge/core";
import { maintain, MaintenanceFailed } from "@palforge/maintenance";
import { saveToolContext } from "@palforge/savetool";
import type { Duration } from "effect";
import { Effect, Schema } from "effect";
import { SavePlan } from "#src/SavePlan.ts";

export class SaveEditFailed extends Schema.TaggedError<SaveEditFailed>()("SaveEditFailed", {
  server: Schema.String,
  message: Schema.String,
}) {}

// What `savetool apply` wrote: a line per change, and the save files it changed, relative to the world directory.
export class EditReport extends Schema.Class<EditReport>("@palforge/save/EditReport")({
  changes: Schema.Array(Schema.String),
  files: Schema.Array(Schema.String),
}) {}

export class SavedPal extends Schema.Class<SavedPal>("@palforge/save/SavedPal")({
  slot: Schema.Int,
  id: Schema.String,
  species: Schema.String,
  level: Schema.Number,
  nickname: Schema.NullOr(Schema.String),
  // Away on an expedition: still listed in the Palbox, but the game does not move it until it is back.
  expedition: Schema.Boolean,
}) {}

export class PlayerSave extends Schema.Class<PlayerSave>("@palforge/save/PlayerSave")({
  player: Schema.String,
  uid: Schema.String,
  party: Schema.Array(SavedPal),
  palbox: Schema.Array(SavedPal),
  // Dimensional Pal Storage; `slot` is the entry.
  dps: Schema.Array(SavedPal),
  inventoryId: Schema.String,
  inventory: Schema.Array(
    Schema.Struct({ slot: Schema.Int, item: Schema.String, count: Schema.Int }),
  ),
}) {}

export interface EditOptions {
  // How long to wait for the last player to leave before the announced countdown, which follows either way.
  readonly waitForEmpty?: Duration.Input | undefined;
  // How long the server runs before its FPS is checked. Default 30 seconds.
  readonly settle?: Duration.Input | undefined;
}

export interface SaveEdit {
  readonly report: EditReport;
  // `<workDir>/saves/<time>` on the host: the original files, the plan, the edited files and the resaved world.
  readonly dir: string;
  readonly fps: number;
}

// The save tool and the server's world, with each step palctl takes on them.
const saveTool = Effect.fn("saveTool")(function* (server: Server) {
  const shell = yield* RemoteShell;
  const failed = (message: string) => new SaveEditFailed({ server: server.name, message });

  const onHost = (script: string, ...args: ReadonlyArray<string>) =>
    shell.run(server, ["sh", "-c", script, "sh", ...args]);

  const image = yield* ensureContextImage(server, "savetool", saveToolContext).pipe(
    Effect.mapError((cause) => failed(cause.message)),
  );

  const gameDir = (yield* shell.run(server, [
    "docker",
    "inspect",
    "-f",
    '{{range .Mounts}}{{if eq .Destination "/palworld"}}{{.Source}}{{end}}{{end}}',
    server.container,
  ])).trim();

  const world = `${gameDir}/Pal/Saved/SaveGames/0/${server.worldGuid}`;

  // A directory for one run, named by the time, under `<workDir>/saves`.
  const newRun = onHost(
    'mkdir -p "$1/saves" && mktemp -d "$1/saves/$(date -u +%Y%m%dT%H%M%SZ)-XXXX"',
    server.workDir,
  ).pipe(Effect.map((out) => out.trim()));

  const copyWorld = (into: string) =>
    onHost(
      `set -eu
mkdir -p "$2/Players"
cp -p "$1/Level.sav" "$1/LevelMeta.sav" "$2/"
cp -p "$1"/Players/*.sav "$2/Players/"`,
      world,
      into,
    );

  const upload = (path: string, content: string) =>
    shell.run(server, ["sh", "-c", 'cat > "$1"', "sh", path], content);

  // The run directory is mounted at /edit; savetool reports a refusal on stderr.
  const savetool = (dir: string, ...args: ReadonlyArray<string>) =>
    onHost(
      'dir="$1" image="$2"; shift 2; exec docker run --rm --network none --memory 4g -v "$dir:/edit" "$image" savetool "$@"',
      dir,
      image,
      ...args,
    ).pipe(
      Effect.catchTag("RemoteCommandFailed", (error) => Effect.fail(failed(error.stderr.trim()))),
    );

  // A running server writes its saves now, so a copy is current; a stopped one already wrote them. The copy waits
  // until Level.sav has changed and then stayed the same for two seconds, so it is not taken mid-write.
  const saveNow = onHost(
    `set -eu
level="$1/Level.sav"
if [ "$(docker inspect -f "{{.State.Running}}" "$2")" != "true" ]; then echo stopped; exit 0; fi
before="$(stat -c %y "$level")"
docker exec "$2" rest-cli save > /dev/null
for second in $(seq 60); do
  now="$(stat -c %y "$level")"
  if [ "$now" != "$before" ]; then
    sleep 2
    if [ "$(stat -c %y "$level")" = "$now" ]; then echo saved; exit 0; fi
  fi
  sleep 1
done
echo timeout`,
    world,
    server.container,
  ).pipe(
    Effect.flatMap((out) =>
      out.trim() === "timeout"
        ? Effect.fail(failed("The server did not write its saves within a minute of being asked"))
        : Effect.void,
    ),
  );

  // savetool sees only the run directory, so each older save that the plan restores from is copied into it first: a
  // Level.sav as it is, or the world's Level.sav out of a backup archive.
  const stagePlan = Effect.fn("stagePlan")(function* (dir: string, plan: SavePlan) {
    const { operations } = Schema.encodeSync(SavePlan)(plan);

    const sources = [
      ...new Set(operations.flatMap((op) => (op.op === "restoreContainer" ? [op.from] : []))),
    ];

    for (const [index, source] of sources.entries()) {
      yield* onHost(
        `set -eu
mkdir -p "$2"
case "$1" in
  *.tar.gz) tar -xzOf "$1" --wildcards "*/$3/Level.sav" > "$2/Level.sav" ;;
  *) cp "$1" "$2/Level.sav" ;;
esac`,
        source,
        `${dir}/sources/${index}`,
        server.worldGuid,
      ).pipe(
        Effect.catchTag("RemoteCommandFailed", (error) =>
          Effect.fail(failed(`Cannot read ${source}: ${error.stderr.trim()}`)),
        ),
      );
    }

    const staged = operations.map((op) =>
      op.op === "restoreContainer"
        ? { ...op, from: `/edit/sources/${sources.indexOf(op.from)}/Level.sav` }
        : op,
    );

    yield* upload(`${dir}/plan.json`, JSON.stringify({ operations: staged }));
  });

  const decode = <A>(schema: Schema.Codec<A>, json: string) =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(json.trim()).pipe(
      Effect.mapError((cause) =>
        failed(`savetool printed something palctl cannot read: ${cause.message}`),
      ),
    );

  return { world, newRun, copyWorld, stagePlan, savetool, saveNow, decode, onHost, failed };
});

// A player's party, Palbox and inventory, from a copy of the server's current saves.
export const showPlayer = Effect.fn("showPlayer")(function* (server: Server, player: string) {
  const tool = yield* saveTool(server);

  yield* tool.saveNow;

  const dir = yield* tool.newRun;

  yield* tool.copyWorld(`${dir}/world`);

  return yield* tool.decode(PlayerSave, yield* tool.savetool(dir, "show", "/edit/world", player));
});

// Applies the plan to a copy of the current saves and reports what it would change, without a restart.
export const previewEdit = Effect.fn("previewEdit")(function* (server: Server, plan: SavePlan) {
  const tool = yield* saveTool(server);

  yield* tool.saveNow;

  const dir = yield* tool.newRun;

  yield* tool.copyWorld(`${dir}/original`);
  yield* tool.stagePlan(dir, plan);

  const out = yield* tool.savetool(
    dir,
    "apply",
    "/edit/original",
    "/edit/plan.json",
    "/edit/candidate",
  );

  return { dir, report: yield* tool.decode(EditReport, out) };
});

// A running server keeps the world in memory and rewrites every save file when it saves, so an edit needs a stop.
// The plan is tried on a copy first; then the server is stopped, the plan is applied to the files its shutdown wrote,
// and the server is started. Once it has saved again, the edit must still be there. Any failure puts back the
// original files.
export const editSave = Effect.fn("editSave")(function* (
  server: Server,
  plan: SavePlan,
  options: EditOptions = {},
) {
  yield* previewEdit(server, plan);

  const tool = yield* saveTool(server);
  const dir = yield* tool.newRun;

  yield* tool.stagePlan(dir, plan);

  const applied: Array<EditReport> = [];

  const whileStopped = Effect.gen(function* () {
    yield* tool.copyWorld(`${dir}/original`);

    const report = yield* tool.decode(
      EditReport,
      yield* tool.savetool(dir, "apply", "/edit/original", "/edit/plan.json", "/edit/candidate"),
    );

    applied.push(report);

    // Each file is listed before it is replaced, so `undo` knows what to put back.
    yield* tool.onHost(
      `set -eu
dir="$1" world="$2"
shift 2
for file in "$@"; do
  owner="$(stat -c %u:%g "$world/$file")"
  mode="$(stat -c %a "$world/$file")"
  echo "$file" >> "$dir/installed"
  install -o "\${owner%:*}" -g "\${owner#*:}" -m "$mode" "$dir/candidate/$file" "$world/$file.palforge"
  mv -f "$world/$file.palforge" "$world/$file"
done`,
      dir,
      tool.world,
      ...report.files,
    );
  });

  const undo = tool.onHost(
    `set -eu
dir="$1" world="$2"
rm -f "$world"/*.palforge "$world"/Players/*.palforge
if [ ! -f "$dir/installed" ]; then exit 0; fi
while read -r file; do
  owner="$(stat -c %u:%g "$world/$file")"
  mode="$(stat -c %a "$world/$file")"
  install -o "\${owner%:*}" -g "\${owner#*:}" -m "$mode" "$dir/original/$file" "$world/$file.palforge"
  mv -f "$world/$file.palforge" "$world/$file"
done < "$dir/installed"`,
    dir,
    tool.world,
  );

  // The server loaded the edited files; after it saves again, they must still hold the edit.
  const persisted = Effect.gen(function* () {
    yield* tool.saveNow;
    yield* tool.copyWorld(`${dir}/resaved`);
    yield* tool.savetool(dir, "verify", "/edit/resaved", "/edit/candidate/report.json");
  });

  const { fps } = yield* maintain(server, {
    reason: "a save edit",
    waitForEmpty: options.waitForEmpty,
    settle: options.settle,
    whileStopped,
    afterStart: persisted,
    undo,
    undone: "the saves from before the edit",
  }).pipe(
    Effect.mapError((error) =>
      error instanceof MaintenanceFailed ? tool.failed(error.message) : error,
    ),
  );

  const [report] = applied;

  if (report === undefined) {
    return yield* tool.failed("The edit finished without a report");
  }

  return { report, dir, fps } satisfies SaveEdit;
});
