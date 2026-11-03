import { randomUUID } from "node:crypto";
import { RemoteShell } from "@palforge/core";
import type { Server } from "@palforge/core";
import { Effect, Schedule, Schema } from "effect";
import { showPlayer } from "#src/SaveEdit.ts";

export class LivePartyFailed extends Schema.TaggedError<LivePartyFailed>()("LivePartyFailed", {
  server: Schema.String,
  message: Schema.String,
}) {}

class NoAnswer extends Schema.TaggedError<NoAnswer>()("NoAnswer", {}) {}

// The folder PalforgeLoadout reads requests from, inside the server's container. It belongs to the game's user, so
// the mod can remove each request and write its answer.
const folder = "/palworld/palforge/loadout";

const hex = (id: string) => id.replaceAll("-", "");

// Sets an online player's party without a restart, through the PalforgeLoadout UE4SS mod on a Windows (Wine)
// server. The Pals must be in the player's party or Palbox, and the server must still hold the new party after it
// saves. Experimental: refer to tools/ue4ss-loadout/README.md.
export const setPartyLive = Effect.fn("setPartyLive")(function* (
  server: Server,
  player: string,
  pals: ReadonlyArray<string>,
) {
  const shell = yield* RemoteShell;
  const failed = (message: string) => new LivePartyFailed({ server: server.name, message });
  const before = yield* showPlayer(server, player);
  const owned = new Map([...before.party, ...before.palbox].map((pal) => [pal.id, pal]));
  const unknown = pals.filter((pal) => !owned.has(pal));

  if (unknown.length > 0) {
    return yield* failed(
      `${before.player} has no Pal ${unknown.join(", ")} in their party or Palbox`,
    );
  }

  // The game refuses the whole switch with "cannot switch preset" after moving the Pals before such a Pal.
  const away = pals.flatMap((id) => {
    const pal = owned.get(id);

    return pal?.expedition === true ? [`${pal.species} ${id}`] : [];
  });

  if (away.length > 0) {
    return yield* failed(`${away.join(", ")} ${away.length === 1 ? "is" : "are"} on an expedition`);
  }

  const request = randomUUID().slice(0, 8);

  yield* shell.run(
    server,
    [
      "docker",
      "exec",
      "-i",
      server.container,
      "sh",
      "-c",
      `set -eu
owner="$(stat -c %u:%g /palworld)"
mkdir -p "$1"
cat > "$1/request.tmp"
chown -R "$owner" "$1"
mv "$1/request.tmp" "$1/request.txt"`,
      "sh",
      folder,
    ],
    `${request} ${hex(before.uid)} ${pals.map(hex).join(" ")}\n`,
  );

  const answer = yield* shell
    .run(server, [
      "docker",
      "exec",
      server.container,
      "sh",
      "-c",
      'grep "^$2 " "$1/result.txt" 2>/dev/null || true',
      "sh",
      folder,
      request,
    ])
    .pipe(
      Effect.flatMap((out) =>
        out.trim() === "" ? Effect.fail(new NoAnswer()) : Effect.succeed(out.trim()),
      ),
      Effect.retry({
        schedule: Schedule.spaced("2 seconds"),
        while: (error) => error instanceof NoAnswer,
      }),
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          Effect.fail(
            failed(
              "PalforgeLoadout did not answer within 30 seconds; the server must be a Windows (Wine) server with the mod installed",
            ),
          ),
      }),
      Effect.mapError((error) => (error instanceof NoAnswer ? failed("No answer") : error)),
    );

  if (answer !== `${request} ok`) {
    return yield* failed(
      `PalforgeLoadout refused the request: ${answer.slice(request.length + 1)}`,
    );
  }

  const after = yield* showPlayer(server, player);
  const party = after.party.map((pal) => pal.id);

  if (party.length !== pals.length || pals.some((pal) => !party.includes(pal))) {
    return yield* failed(
      `The server took the request, but after saving the party holds ${party.join(", ") || "no Pals"}`,
    );
  }

  return after;
});
