import { RemoteShell, Server } from "@palforge/core";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  dumpedFile,
  dumperLua,
  dumpMappings,
  MappingsDumpFailed,
  parseBuildId,
} from "#src/index.ts";

const canary = new Server({
  name: "canary",
  sshHost: "palworld-canary",
  container: "palworld-server",
  worldGuid: "0123456789ABCDEF0123456789ABCDEF",
});

const manifest = (buildId: string) => `"AppState"
{
	"appid"		"2394010"
	"buildid"		"${buildId}"
	"LastUpdated"		"1793276620"
}`;

// What the status script printed on the canary on 2026-11-02 once the dump had finished.
const successLog = `completed
file=Pal-5.1.1-0+++UE5+Release-5.1-2281fa31.usmap
running=true`;

interface Host {
  readonly cached: boolean;
  readonly status: string;
  readonly dumperBuildId: string;
  readonly header: string;
}

const healthyHost: Host = {
  cached: false,
  status: successLog,
  dumperBuildId: "25247047",
  header: "c43004",
};

// Answers each remote command by what its script does and records every script it was asked to run.
const fakeHost = (host: Host) => {
  const scripts: Array<string> = [];

  const reply = (argv: ReadonlyArray<string>) => {
    const script = argv[2] ?? "";

    if (argv[0] === "docker" && argv[1] === "exec") {
      return manifest("25247047");
    }

    scripts.push(script);

    if (script.startsWith("test -f")) {
      return host.cached ? "cached\n" : "";
    }

    if (script.includes("docker logs")) {
      return host.status;
    }

    if (script.startsWith("cat ")) {
      return manifest(host.dumperBuildId);
    }

    if (script.includes("cp ")) {
      return host.header;
    }

    return "";
  };

  const layer = Layer.succeed(
    RemoteShell,
    RemoteShell.of({ run: (_server, argv) => Effect.succeed(reply(argv)) }),
  );

  return { layer, scripts };
};

const dumpOn = (host: Host) => {
  const fake = fakeHost(host);

  return {
    scripts: fake.scripts,
    run: () => Effect.runPromise(dumpMappings(canary).pipe(Effect.provide(fake.layer))),
    fail: () =>
      Effect.runPromise(Effect.flip(dumpMappings(canary).pipe(Effect.provide(fake.layer)))),
  };
};

describe("dumpMappings", () => {
  it("reuses mappings already dumped for the server's build", async () => {
    const dump = dumpOn({ ...healthyHost, cached: true });

    expect(await dump.run()).toEqual({
      buildId: "25247047",
      path: "/srv/palforge/mappings/25247047.usmap",
      generated: false,
    });

    expect(dump.scripts.some((script) => script.includes("docker run"))).toBe(false);
  });

  it("runs the dumper, stores the mappings by build ID and removes the container", async () => {
    const dump = dumpOn(healthyHost);

    expect(await dump.run()).toEqual({
      buildId: "25247047",
      path: "/srv/palforge/mappings/25247047.usmap",
      generated: true,
    });

    expect(dump.scripts.some((script) => script.includes("docker run -d"))).toBe(true);
    expect(dump.scripts.some((script) => script.includes("docker stop"))).toBe(true);
    expect(dump.scripts.at(-1)).toContain("docker rm");
  });

  it("fails and keeps the stopped container when the dumper exits without mappings", async () => {
    const dump = dumpOn({ ...healthyHost, status: "running=false" });
    const error = await dump.fail();

    expect(error).toBeInstanceOf(MappingsDumpFailed);
    expect(error.message).toContain("docker logs");
    expect(dump.scripts.some((script) => script.includes("docker stop"))).toBe(true);
    expect(dump.scripts.some((script) => script.includes('docker rm "'))).toBe(false);
  });

  it("refuses mappings from a different build than the server runs", async () => {
    const dump = dumpOn({ ...healthyHost, dumperBuildId: "25300000" });
    const error = await dump.fail();

    expect(error.message).toContain("25300000");
    expect(dump.scripts.some((script) => script.startsWith("mv "))).toBe(false);
  });

  it("refuses an output file that is not a usmap", async () => {
    const error = await dumpOn({ ...healthyHost, header: "504b03" }).fail();

    expect(error.message).toContain("504b03");
  });
});

describe("log and manifest parsing", () => {
  it("reads the Steam build ID from an app manifest", () => {
    expect(parseBuildId(manifest("25247047"))).toEqual(Option.some("25247047"));
    expect(parseBuildId("{}")).toEqual(Option.none());
  });

  it("takes the dumped file only once UE4SS has logged success", () => {
    expect(dumpedFile(successLog)).toEqual(
      Option.some("Pal-5.1.1-0+++UE5+Release-5.1-2281fa31.usmap"),
    );

    expect(dumpedFile("file=stale.usmap\nrunning=true")).toEqual(Option.none());
  });

  it("keeps the Lua mod's string escapes intact", () => {
    expect(dumperLua).toContain('print("[palforge] DumpUSMAP returned\\n")');
  });
});
