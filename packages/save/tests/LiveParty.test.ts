import { NodeServices } from "@effect/platform-node";
import { RemoteShell, Server } from "@palforge/core";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { LivePartyFailed, setPartyLive } from "#src/index.ts";

const staging = new Server({
  name: "staging",
  sshHost: "palworld-staging",
  container: "palworld-staging",
  worldGuid: "0123456789ABCDEF0123456789ABCDEF",
});

const lamball = "3f2a8c10-5b7e-4d21-9a6c-0e4b7d1f2a01";
const cattiva = "7c41e9b2-0d3f-4a58-b6e7-2f9a1c3d4e02";
const chikipi = "a95d03f4-6e12-4b7c-8d90-3c5e7f1a2b03";

// In the Palbox, but away on an expedition.
const away = "d4e5f6a7-1b2c-4d3e-9f80-5a6b7c8d9e04";

const pal = (id: string, slot: number) => ({
  slot,
  id,
  species: "SheepBall",
  level: 1,
  nickname: null,
  expedition: id === away,
});

interface Host {
  // What PalforgeLoadout appends to result.txt for a request, after the request ID.
  readonly answer: string;
  // Whether the server really changes the party when the mod answers "ok".
  readonly applies: boolean;
}

// Plays a Wine server with PalforgeLoadout: the saved party changes once a request is applied.
const fakeHost = (host: Host) => {
  const requests: Array<string> = [];
  let party = [lamball];

  const reply = (argv: ReadonlyArray<string>, input?: string) => {
    const containerScript =
      argv[0] === "docker" && argv[1] === "exec"
        ? (argv.find((arg) => arg.includes("$1/")) ?? "")
        : "";

    if (containerScript.includes("request.tmp")) {
      const request = input ?? "";

      requests.push(request);

      if (host.applies && host.answer === "ok") {
        party = [cattiva, chikipi].filter((id) => request.includes(id.replaceAll("-", "")));
      }

      return Effect.succeed("");
    }

    if (containerScript.includes("result.txt")) {
      return Effect.succeed(`${requests.at(-1)?.split(" ")[0]} ${host.answer}\n`);
    }

    if (argv[0] === "docker" && argv[1] === "inspect") {
      return Effect.succeed("/srv/staging/data\n");
    }

    const shellScript = argv[2] ?? "";

    if (shellScript.includes("docker image inspect")) {
      return Effect.succeed("present\n");
    }

    if (shellScript.includes("mktemp")) {
      return Effect.succeed("/srv/palforge/saves/run\n");
    }

    if (shellScript.includes("rest-cli save")) {
      return Effect.succeed("saved\n");
    }

    if (shellScript.includes("docker run")) {
      return Effect.succeed(
        JSON.stringify({
          player: "Ayla",
          uid: "1a2b3c4d-0000-0000-0000-000000000000",
          party: party.map(pal),
          palbox: [cattiva, chikipi, away].flatMap((id, slot) =>
            party.includes(id) ? [] : [pal(id, slot)],
          ),
          dps: [],
          inventoryId: "6e1f0c3a-0000-4000-8000-000000000001",
          inventory: [],
        }),
      );
    }

    return Effect.succeed("");
  };

  const shell = Layer.succeed(
    RemoteShell,
    RemoteShell.of({ run: (_, argv, input) => Effect.suspend(() => reply(argv, input)) }),
  );

  const run = (pals: ReadonlyArray<string>) =>
    setPartyLive(staging, "Ayla", pals).pipe(
      Effect.provide(Layer.mergeAll(shell, NodeServices.layer)),
    );

  return { requests, run };
};

describe("setPartyLive", () => {
  it("refuses a Pal the player does not have before asking the server", async () => {
    const fake = fakeHost({ answer: "ok", applies: true });

    const error = await Effect.runPromise(
      Effect.flip(fake.run(["00000000-0000-0000-0000-000000000001"])),
    );

    expect(error).toBeInstanceOf(LivePartyFailed);
    expect(error.message).toContain("Ayla has no Pal 00000000-0000-0000-0000-000000000001");
    expect(fake.requests).toEqual([]);
  });

  it("refuses a Pal on an expedition before asking the server", async () => {
    const fake = fakeHost({ answer: "ok", applies: true });
    const error = await Effect.runPromise(Effect.flip(fake.run([cattiva, away])));

    expect(error.message).toBe(`SheepBall ${away} is on an expedition`);
    expect(fake.requests).toEqual([]);
  });

  it("sends the player and Pal IDs without dashes and checks the saved party", async () => {
    const fake = fakeHost({ answer: "ok", applies: true });
    const saved = await Effect.runPromise(fake.run([cattiva, chikipi]));

    expect(fake.requests[0]).toMatch(
      /^\w{8} 1a2b3c4d000000000000000000000000 7c41e9b20d3f4a58b6e72f9a1c3d4e02 a95d03f46e124b7c8d903c5e7f1a2b03\n$/u,
    );
    expect(saved.party.map((saved) => saved.id)).toEqual([cattiva, chikipi]);
  });

  it("reports the mod's refusal", async () => {
    const fake = fakeHost({ answer: "error the player is not online", applies: false });
    const error = await Effect.runPromise(Effect.flip(fake.run([cattiva])));

    expect(error.message).toBe(
      "PalforgeLoadout refused the request: error the player is not online",
    );
  });

  it("fails when the server answers but does not keep the party", async () => {
    const fake = fakeHost({ answer: "ok", applies: false });
    const error = await Effect.runPromise(Effect.flip(fake.run([cattiva])));

    expect(error.message).toContain(`after saving the party holds ${lamball}`);
  });
});
