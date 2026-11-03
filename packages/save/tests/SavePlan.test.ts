import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { decodeSavePlan, SavePlanError } from "#src/index.ts";

const decode = (json: string) => decodeSavePlan(json, "plan.json");

const pal = "3f2a8c10-5b7e-4d21-9a6c-0e4b7d1f2a01";
const container = "6e1f0c3a-0000-4000-8000-000000000001";
const backup = "/srv/backups/world-0600.tar.gz";

describe("decodeSavePlan", () => {
  it("reads every operation", async () => {
    const plan = await Effect.runPromise(
      decode(
        JSON.stringify({
          operations: [
            { op: "movePal", pal, to: "palbox" },
            { op: "movePal", pal, to: "dps", slot: 9599 },
            { op: "setParty", player: "Ayla", pals: [pal] },
            { op: "giveItem", player: "Ayla", item: "Money", count: 10 },
            { op: "restoreContainer", container, from: backup },
            { op: "restoreContainer", container, from: "/srv/saves/run/original/Level.sav" },
          ],
        }),
      ),
    );

    expect(plan.operations.map((operation) => operation.op)).toEqual([
      "movePal",
      "movePal",
      "setParty",
      "giveItem",
      "restoreContainer",
      "restoreContainer",
    ]);
  });

  it.each([
    ["an unknown key", { operations: [{ op: "movePal", pal, to: "party", slots: 1 }] }],
    ["an unknown operation", { operations: [{ op: "deletePal", pal }] }],
    [
      "an upper-case Pal ID",
      { operations: [{ op: "movePal", pal: pal.toUpperCase(), to: "party" }] },
    ],
    [
      "a party of six",
      { operations: [{ op: "setParty", player: "Ayla", pals: Array(6).fill(pal) }] },
    ],
    [
      "more than a stack",
      { operations: [{ op: "giveItem", player: "Ayla", item: "Money", count: 10000 }] },
    ],
    ["a slot past the storage", { operations: [{ op: "movePal", pal, to: "dps", slot: 9600 }] }],
    [
      "a relative restore source",
      { operations: [{ op: "restoreContainer", container, from: "backups/world.tar.gz" }] },
    ],
    [
      "a restore source that is no save or archive",
      { operations: [{ op: "restoreContainer", container, from: "/srv/backups/world.zip" }] },
    ],
    ["no operations", { operations: [] }],
  ])("refuses %s", async (_, plan) => {
    const error = await Effect.runPromise(Effect.flip(decode(JSON.stringify(plan))));

    expect(error).toBeInstanceOf(SavePlanError);
  });
});
