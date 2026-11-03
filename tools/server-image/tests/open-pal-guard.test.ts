import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { serverImageContext } from "#index.ts";

const guard = join(serverImageContext.dir, "open-pal-guard.sh");
const pakBytes = "pretend pak bytes";
const pakSha256 = createHash("sha256").update(pakBytes).digest("hex");

interface GameDir {
  readonly installedBuild: string;
  readonly pak?: string;
  readonly manifest?: string;
}

// Lays out the parts of /palworld the guard reads, then runs the guard against it.
const runGuard = (game: GameDir) => {
  const root = mkdtempSync(join(tmpdir(), "open-pal-guard-"));
  const mods = join(root, "Pal/Content/Paks/~mods");

  mkdirSync(mods, { recursive: true });
  mkdirSync(join(root, "steamapps"));
  writeFileSync(
    join(root, "steamapps/appmanifest_2394010.acf"),
    `"AppState"\n{\n\t"appid"\t\t"2394010"\n\t"buildid"\t\t"${game.installedBuild}"\n}\n`,
  );

  if (game.pak !== undefined) {
    writeFileSync(join(mods, "OpenPal_P.pak"), game.pak);
  }

  if (game.manifest !== undefined) {
    writeFileSync(join(mods, "OpenPal_P.manifest.json"), game.manifest);
  }

  const result = spawnSync("bash", [guard], {
    env: { ...process.env, PALWORLD_ROOT: root },
    encoding: "utf8",
  });

  const disabled = join(root, "open-pal-disabled");

  return {
    status: result.status,
    output: result.stdout,
    pakInPlace: existsSync(join(mods, "OpenPal_P.pak")),
    movedAside: existsSync(disabled) ? readdirSync(disabled).length : 0,
    // The engine mounts every .pak anywhere under Pal/Content/Paks, so a refused pak must not stay in it.
    paksUnderPaks: readdirSync(join(root, "Pal/Content/Paks"), { recursive: true }).filter(
      (entry) => String(entry).endsWith(".pak"),
    ).length,
  };
};

const manifest = (gameBuildId: string, sha256: string) =>
  JSON.stringify({ gameBuildId, buildHash: "0e6531b049ec", pakSha256: sha256 }, null, 2);

describe("open-pal start-time guard", () => {
  it("does nothing on a vanilla server", () => {
    expect(runGuard({ installedBuild: "25247047" })).toMatchObject({
      status: 0,
      output: "",
      movedAside: 0,
    });
  });

  it("keeps a pak built for the installed game build", () => {
    const result = runGuard({
      installedBuild: "25247047",
      pak: pakBytes,
      manifest: manifest("25247047", pakSha256),
    });

    expect(result).toMatchObject({ status: 0, pakInPlace: true, movedAside: 0 });
    expect(result.output).toContain("matches game build 25247047");
  });

  it("moves aside a pak built for another game build", () => {
    const result = runGuard({
      installedBuild: "25300000",
      pak: pakBytes,
      manifest: manifest("25247047", pakSha256),
    });

    expect(result).toMatchObject({ status: 0, pakInPlace: false, movedAside: 1, paksUnderPaks: 0 });
    expect(result.output).toContain(
      "built for game build 25247047 but build 25300000 is installed",
    );
  });

  it("moves aside a pak whose bytes no longer match its manifest", () => {
    const result = runGuard({
      installedBuild: "25247047",
      pak: `${pakBytes}!`,
      manifest: manifest("25247047", pakSha256),
    });

    expect(result).toMatchObject({ status: 0, pakInPlace: false, movedAside: 1, paksUnderPaks: 0 });
    expect(result.output).toContain("SHA-256 does not match");
  });

  it("moves aside a pak without a readable manifest", () => {
    const result = runGuard({ installedBuild: "25247047", pak: pakBytes });

    expect(result).toMatchObject({ status: 0, pakInPlace: false, movedAside: 1, paksUnderPaks: 0 });
    expect(result.output).toContain("no readable manifest");
  });
});
