import { createHash } from "node:crypto";
import { RemoteShell } from "@palforge/core";
import type { Server } from "@palforge/core";
import { announce } from "@palforge/maintenance";
import { OpenPalConfig, recipeFor } from "@palforge/open-pal";
import type { OpenPalEvent } from "@palforge/open-pal";
import type { Duration } from "effect";
import { Effect, Option, Schema } from "effect";
import { buildPack, PackManifest, packFile } from "#src/PackBuilder.ts";
import { deployPack } from "#src/PackDeploy.ts";

// Kept on the host in `<workDir>/events/<server>.json`, as servers can share a host: the events the server ran
// after its last sync, and the settings whose deploy failed there, which sync does not try again.
export class EventState extends Schema.Class<EventState>("@palforge/pack/EventState")({
  active: Schema.Array(Schema.String),
  failedConfig: Schema.NullOr(Schema.String),
}) {}

export interface SyncOptions {
  // How long to wait for the last player to leave before the announced countdown, which follows either way.
  readonly waitForEmpty?: Duration.Input | undefined;
  // How long a restarted server runs before its FPS is checked (see DeployOptions).
  readonly settle?: Duration.Input | undefined;
}

export interface SyncResult {
  readonly server: string;
  readonly deployed: boolean;
  readonly started: ReadonlyArray<string>;
  readonly ended: ReadonlyArray<string>;
  // Why sync left the server as it is, although its pack does not match the settings.
  readonly held?: string | undefined;
}

const settingsHash = (config: OpenPalConfig) =>
  createHash("sha256")
    .update(JSON.stringify(Schema.encodeSync(OpenPalConfig)(config)))
    .digest("hex")
    .slice(0, 12);

// The manifest of the pack the server would load at its next start; none when no pak is installed.
export const installedPack = Effect.fn("installedPack")(function* (server: Server) {
  const shell = yield* RemoteShell;

  const gameDir = (yield* shell.run(server, [
    "docker",
    "inspect",
    "-f",
    '{{range .Mounts}}{{if eq .Destination "/palworld"}}{{.Source}}{{end}}{{end}}',
    server.container,
  ])).trim();

  const manifest = yield* shell.run(server, [
    "sh",
    "-c",
    'if [ -f "$1/$2" ]; then cat "$1/OpenPal_P.manifest.json"; fi',
    "sh",
    `${gameDir}/Pal/Content/Paks/~mods`,
    packFile,
  ]);

  return manifest.trim() === ""
    ? Option.none<PackManifest>()
    : Option.some(yield* Schema.decodeEffect(Schema.fromJsonString(PackManifest))(manifest));
});

// Makes the server run `config`, the settings with the events active now applied. It deploys only when the installed
// pack differs, so it can run every few minutes. Players are told when an event starts and ends.
export const syncEvents = Effect.fn("syncEvents")(function* (
  server: Server,
  config: OpenPalConfig,
  active: ReadonlyArray<OpenPalEvent>,
  options: SyncOptions = {},
) {
  const shell = yield* RemoteShell;
  const statePath = `${server.workDir}/events/${server.name}.json`;

  const saved = yield* shell.run(server, [
    "sh",
    "-c",
    'cat "$1" 2>/dev/null || echo \'{"active":[],"failedConfig":null}\'',
    "sh",
    statePath,
  ]);

  const state = yield* Schema.decodeEffect(Schema.fromJsonString(EventState))(saved.trim());

  const writeState = (next: EventState) =>
    shell.run(
      server,
      ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", statePath],
      JSON.stringify(Schema.encodeSync(EventState)(next)),
    );

  const installed = yield* installedPack(server);
  const wanted = settingsHash(config);
  const hasFeatures = (yield* recipeFor(config)).length > 0;

  const current = Option.match(installed, {
    onNone: () => !hasFeatures,
    onSome: (manifest) => hasFeatures && settingsHash(manifest.config) === wanted,
  });

  const names = active.map((event) => event.name);
  const started = active.filter((event) => !state.active.includes(event.name));
  const ended = state.active.filter((name) => !names.includes(name));
  const result = { server: server.name, started: started.map((event) => event.name), ended };

  if (!current && state.failedConfig === wanted) {
    return {
      ...result,
      deployed: false,
      held: "the last deploy of these settings failed; fix the config or deploy by hand",
    } satisfies SyncResult;
  }

  if (!current) {
    const reason =
      started.length > 0
        ? `the ${result.started.join(" and ")} event`
        : ended.length > 0
          ? `the end of the ${ended.join(" and ")} event`
          : "a quality-of-life update";

    yield* buildPack(server, config).pipe(
      Effect.flatMap((built) => deployPack(server, built, { ...options, reason })),
      Effect.tapError(() =>
        writeState(new EventState({ active: state.active, failedConfig: wanted })),
      ),
    );
  }

  for (const event of started) {
    yield* announce(server, event.message);
  }

  for (const name of ended) {
    yield* announce(server, `The ${name} event has ended.`);
  }

  yield* writeState(new EventState({ active: names, failedConfig: null }));

  return { ...result, deployed: !current, held: undefined } satisfies SyncResult;
});
