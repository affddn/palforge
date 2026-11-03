import { NodeServices } from "@effect/platform-node";
import { DateTime, Effect, FileSystem, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  decodeOpenPalConfig,
  decodeOpenPalEvents,
  features,
  OpenPalConfig,
  OpenPalConfigError,
  OpenPalConfigJson,
  readOpenPalConfig,
  vanillaConfig,
} from "#src/index.ts";

const decode = (json: string) => Effect.runPromise(Schema.decodeEffect(OpenPalConfigJson)(json));

describe("OpenPalConfig", () => {
  it("is vanilla when the operator sets nothing", async () => {
    const config = await decode("{}");

    expect(config.guildChest.enabled).toBe(false);
    expect(config.storage.enabled).toBe(false);
    expect(config.expeditions.enabled).toBe(false);
  });

  it("fills unset settings of an enabled feature with its defaults", async () => {
    const config = await decode(`{"guildChest":{"enabled":true}}`);

    expect(config.guildChest).toMatchObject({ enabled: true, slots: 444 });
  });

  it("keeps the operator's values", async () => {
    const config = await decode(
      `{"guildChest":{"enabled":true,"slots":120},"expeditions":{"enabled":true,"durationMultiplier":0.5}}`,
    );

    expect(config.guildChest.slots).toBe(120);
    expect(config.expeditions.durationMultiplier).toBe(0.5);
  });

  it("rejects a value outside its allowed range before anything is built", async () => {
    await expect(decode(`{"guildChest":{"enabled":true,"slots":5000}}`)).rejects.toThrow();
    await expect(decode(`{"expeditions":{"durationMultiplier":0}}`)).rejects.toThrow();
  });

  it("lists a catalog entry for every configurable feature", () => {
    expect(features.map((feature) => feature.id).toSorted()).toEqual(
      Object.keys(OpenPalConfig.fields).toSorted(),
    );
  });
});

describe("loading the open-pal config", () => {
  it("treats the vanilla config as every feature off", () => {
    expect(features.some((feature) => vanillaConfig[feature.id].enabled)).toBe(false);
  });

  it("reads the operator's config file", async () => {
    const config = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* fs.makeTempFileScoped({ suffix: ".json" });

        yield* fs.writeFileString(path, `{"storage":{"enabled":true,"slotMultiplier":3}}`);

        return yield* readOpenPalConfig(path);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(config.storage).toMatchObject({ enabled: true, slotMultiplier: 3 });
  });

  it("fails with the path when a configured file does not exist", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        readOpenPalConfig("/nonexistent/palforge/open-pal.json").pipe(
          Effect.provide(NodeServices.layer),
        ),
      ),
    );

    expect(error).toBeInstanceOf(OpenPalConfigError);
    expect(error.source).toBe("/nonexistent/palforge/open-pal.json");
  });

  it("names the source and the offending setting when a value is out of range", async () => {
    const error = await Effect.runPromise(
      Effect.flip(decodeOpenPalConfig(`{"guildChest":{"slots":5000}}`, "$PALFORGE_OPEN_PAL")),
    );

    expect(error.message).toContain("$PALFORGE_OPEN_PAL");
    expect(error.message).toContain("slots");
  });
});

describe("per-server settings", () => {
  const file = JSON.stringify({
    guildChest: { enabled: true, slots: 444 },
    expeditions: { enabled: true },
    servers: {
      main: { guildChest: { enabled: false }, expeditions: { durationMultiplier: 0.5 } },
    },
  });

  const load = (json: string, server?: string) =>
    Effect.runPromise(decodeOpenPalConfig(json, "test", server));

  const loadError = (json: string, server?: string) =>
    Effect.runPromise(Effect.flip(decodeOpenPalConfig(json, "test", server)));

  it("merges a server's overrides into the shared settings feature by feature", async () => {
    const main = await load(file, "main");

    expect(main.guildChest).toMatchObject({ enabled: false, slots: 444 });
    expect(main.expeditions).toMatchObject({ enabled: true, durationMultiplier: 0.5 });
  });

  it("gives other servers the shared settings", async () => {
    const canary = await load(file, "canary");

    expect(canary.guildChest).toMatchObject({ enabled: true, slots: 444 });
    expect(canary.expeditions.durationMultiplier).toBe(0.25);
  });

  it("rejects a key it does not know instead of ignoring it", async () => {
    const error = await loadError(`{"guildchest":{"enabled":true}}`);

    expect(error).toBeInstanceOf(OpenPalConfigError);
    expect(error.message).toContain("guildchest");
  });

  it("checks every server's overrides, not only the one being loaded", async () => {
    const typo = JSON.stringify({ servers: { main: { crops: { growthMultipler: 0.5 } } } });
    const error = await loadError(typo, "canary");

    expect(error.message).toContain("servers.main");
  });

  it("rejects an override that is out of range once merged", async () => {
    const error = await loadError(
      JSON.stringify({ servers: { main: { guildChest: { slots: 5000 } } } }),
      "main",
    );

    expect(error.message).toContain("slots");
  });

  it("rejects a servers section that is not an object", async () => {
    const error = await loadError(`{"servers":[]}`);

    expect(error.message).toContain("`servers`");
  });
});

describe("events", () => {
  const file = JSON.stringify({
    breeding: { enabled: true, timeMultiplier: 0.5 },
    servers: { main: { breeding: { enabled: false } } },
    events: {
      "egg-weekend": {
        start: "2026-11-07T00:00:00+08:00",
        end: "2026-11-09T00:00:00+08:00",
        message: "Egg weekend: eggs come four times as fast",
        features: { breeding: { enabled: true, timeMultiplier: 0.25 } },
      },
      "canary-crops": {
        start: "2026-11-08T00:00:00Z",
        end: "2026-11-10T00:00:00Z",
        message: "Crops grow faster",
        servers: ["canary"],
        features: { crops: { enabled: true } },
      },
    },
  });

  const at = (iso: string) => DateTime.makeUnsafe(iso);

  const load = (json: string, server: string, time: string) =>
    Effect.runPromise(decodeOpenPalConfig(json, "test", server, at(time)));

  const loadError = (json: string) =>
    Effect.runPromise(
      Effect.flip(decodeOpenPalConfig(json, "test", "canary", at("2026-11-08T00:00:00Z"))),
    );

  it("applies an event only between its start and its end", async () => {
    const before = await load(file, "main", "2026-11-06T15:59:59Z");
    const during = await load(file, "main", "2026-11-06T16:00:00Z");
    const after = await load(file, "main", "2026-11-08T16:00:00Z");

    expect(before.breeding.enabled).toBe(false);
    expect(during.breeding).toMatchObject({ enabled: true, timeMultiplier: 0.25 });
    expect(after.breeding.enabled).toBe(false);
  });

  it("applies an event only to the servers it names", async () => {
    const canary = await load(file, "canary", "2026-11-08T12:00:00Z");
    const main = await load(file, "main", "2026-11-08T12:00:00Z");

    expect(canary.crops.enabled).toBe(true);
    expect(canary.breeding.timeMultiplier).toBe(0.25);
    expect(main.crops.enabled).toBe(false);
  });

  it("applies no event without a time", async () => {
    const config = await Effect.runPromise(decodeOpenPalConfig(file, "test", "canary"));

    expect(config.breeding.timeMultiplier).toBe(0.5);
  });

  it("checks every event, also one that is not active", async () => {
    const typo = JSON.stringify({
      events: {
        later: {
          start: "2027-01-01T00:00:00Z",
          end: "2027-01-02T00:00:00Z",
          message: "Later",
          features: { crops: { growthMultipler: 0.5 } },
        },
      },
    });

    expect((await loadError(typo)).message).toContain("events.later");
  });

  it("rejects an event that ends before it starts", async () => {
    const backwards = JSON.stringify({
      events: {
        backwards: {
          start: "2027-01-02T00:00:00Z",
          end: "2027-01-01T00:00:00Z",
          message: "Backwards",
          features: {},
        },
      },
    });

    expect((await loadError(backwards)).message).toContain("must end after it starts");
  });

  it("lists the events in the order they start", async () => {
    const events = await Effect.runPromise(decodeOpenPalEvents(file, "test"));

    expect(events.map((event) => event.name)).toEqual(["egg-weekend", "canary-crops"]);
  });
});
