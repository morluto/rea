import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { parseConfig } from "../config/parseConfig.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { silentLogger } from "../logger.js";
import {
  GHIDRA_SESSION_CAPABILITIES,
  parseGhidraSessionInfo,
} from "./GhidraSessionValues.js";
import {
  ghidraSeedCommitmentSchema,
  ghidraSeedFailure,
  ghidraSeedReportSchema,
  ghidraSeedLimitations,
  resolveGhidraAnalysisSeeds,
  snapshotGhidraAnalysisSeeds,
  type GhidraSeedCommitment,
  type GhidraSeedReport,
} from "./GhidraAnalysisSeeds.js";
import { ghidraProfileInstallationHost as host } from "./GhidraInstallation.fixture.js";
import { GhidraProvider } from "./GhidraProvider.js";
import { parseGhidraSeeds } from "../domain/native/ghidraSeedFile.js";

let resources = new ArtifactResourceScope();
afterEach(async () => {
  await resources.close();
  resources = new ArtifactResourceScope();
});
const workspace = () => createTestTempDirectory("rea-ghidra-seeds-");

const resolveSeedProfile = async (path: string) => {
  const config = parseConfig({
    GHIDRA_INSTALL_DIR: "/ghidra",
    REA_GHIDRA_SEED_FILE: path,
  });
  if (!config.ok) throw config.error;
  const provider = new GhidraProvider(config.value, silentLogger, {}, host);
  const target: BinaryTarget = {
    path: "/fixture.exe",
    sha256: "a".repeat(64),
    kind: "executable",
    format: "pe",
    architecture: "x86",
    availableArchitectures: ["x86"],
    executableRole: "application",
    managed: false,
  };
  try {
    return await provider.resolveAnalysisProfile(target);
  } finally {
    await provider.closeOwnedResources();
  }
};

const SEEDS = [
  "# comment and blank lines are ignored",
  "",
  "0x401000\tfunction\tentry",
  "0x00401046\tfunction",
  "0x40A1C4\tcode\r",
  "0x402200\tlabel\tExample::render",
  "",
].join("\n");
const CANONICAL =
  "0x401000\tfunction\tentry\n0x401046\tfunction\n0x40a1c4\tcode\n0x402200\tlabel\tExample::render\n";

describe("Ghidra seed parsing", () => {
  it.each([
    ["401000\tfunction", "line 1: address must be 0x-prefixed hex"],
    ["0x401000\tdata", "line 1: kind must be function, code or label"],
    ["0x401000", "line 1: expected address<TAB>kind[<TAB>name]"],
    ["0x401000\tlabel", "line 1: a label seed requires a name"],
    [
      "0x401000\tcode\tname",
      "line 1: a code seed takes no name; add a label seed",
    ],
    [
      "0x401000\tfunction\ttwo words",
      "line 1: name must be 1..2000 characters without whitespace",
    ],
    [
      "0x401000\tcode\n0x0401000\tcode",
      "line 2: duplicate code seed at 0x0401000",
    ],
  ])("rejects %j", (text, constraint) => {
    const parsed = parseGhidraSeeds(text);
    if (parsed.ok) throw new Error("Expected a seed error");
    expect(parsed.error.settings).toEqual([
      { setting: "REA_GHIDRA_SEED_FILE", constraint },
    ]);
  });
});

describe("Ghidra seed commitment", () => {
  it("commits and snapshots the canonical seeds from a UTF-8 file with a byte-order mark", async () => {
    const path = join(await workspace(), "seeds.tsv");
    await writeFile(path, `\uFEFF${SEEDS}`);
    const resolved = await resolveSeedProfile(path);
    if (!resolved.ok) throw resolved.error;
    const commitment = ghidraSeedCommitmentSchema.parse(
      resolved.value.profile?.parameters.analysis_seeds,
    );
    expect(commitment).toMatchObject({
      format: "rea-ghidra-seeds-v1",
      configured_path: path,
      sha256: createHash("sha256").update(CANONICAL).digest("hex"),
      entries: { function: 2, code: 1, label: 1 },
    });
    const runtime = await workspace();
    const snapshot = await snapshotGhidraAnalysisSeeds(
      commitment,
      runtime,
      resources,
    );
    expect(await readFile(snapshot, "utf8")).toBe(CANONICAL);
  });

  it("is absent when no seed file is configured", async () => {
    const resolved = await resolveGhidraAnalysisSeeds(undefined, resources);
    expect(resolved.ok && resolved.value).toBeUndefined();
  });

  it("refuses a seed file that changed after the profile was committed", async () => {
    const directory = await workspace();
    const path = join(directory, "seeds.tsv");
    await writeFile(path, SEEDS);
    const resolved = await resolveGhidraAnalysisSeeds(path, resources);
    if (!resolved.ok || resolved.value === undefined)
      throw new Error("Expected a commitment");
    await writeFile(path, `${SEEDS}0x401100\tcode\n`);
    await expect(
      snapshotGhidraAnalysisSeeds(resolved.value, await workspace(), resources),
    ).rejects.toMatchObject({
      _tag: "ProviderAdapterError",
      diagnostics: {
        code: "seed_changed",
        path: resolved.value.path,
        reason: "seed_changed",
      },
    });
  });

  it("commits the resolved path behind a configured symbolic link", async () => {
    const directory = await workspace();
    const path = join(directory, "seeds.tsv");
    await writeFile(path, SEEDS);
    const link = join(directory, "link.tsv");
    await symlink(path, link);
    const resolved = await resolveGhidraAnalysisSeeds(link, resources);
    if (!resolved.ok || resolved.value === undefined)
      throw new Error("Expected a commitment");
    expect(resolved.value.path).toBe(await realpath(path));
  });

  it.skipIf(process.platform === "win32")(
    "rejects an invalid file/.. traversal instead of reading a sibling seed file",
    async () => {
      const directory = await workspace();
      await writeFile(join(directory, "file"), "not a directory");
      await writeFile(join(directory, "seeds.tsv"), SEEDS);
      const configured = `${directory}/file/../seeds.tsv`;
      await expect(open(configured)).rejects.toMatchObject({ code: "ENOTDIR" });
      const resolved = await resolveGhidraAnalysisSeeds(configured, resources);
      expect(resolved.ok).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves symlink/.. lookup against a sibling decoy",
    async () => {
      const directory = await workspace();
      const selected = join(directory, "selected");
      await mkdir(join(selected, "child"), { recursive: true });
      await writeFile(join(selected, "seeds.tsv"), SEEDS);
      await writeFile(join(directory, "seeds.tsv"), "0x1234\tcode\n");
      const link = join(directory, "link");
      await symlink(join(selected, "child"), link);
      const configured = `${link}/../seeds.tsv`;
      const resolved = await resolveGhidraAnalysisSeeds(configured, resources);
      if (!resolved.ok || resolved.value === undefined)
        throw new Error("Expected a commitment");
      expect(resolved.value.configured_path).toBe(configured);
      expect(resolved.value.path).toBe(
        await realpath(join(selected, "seeds.tsv")),
      );
      const snapshot = await snapshotGhidraAnalysisSeeds(
        resolved.value,
        await workspace(),
        resources,
      );
      expect(await readFile(snapshot, "utf8")).toBe(CANONICAL);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a configured traversal that becomes invalid before snapshotting",
    async () => {
      const directory = await workspace();
      const child = join(directory, "child");
      await mkdir(child);
      await writeFile(join(directory, "seeds.tsv"), SEEDS);
      const configured = `${child}/../seeds.tsv`;
      const resolved = await resolveGhidraAnalysisSeeds(configured, resources);
      if (!resolved.ok || resolved.value === undefined)
        throw new Error("Expected a commitment");
      await rm(child, { recursive: true });
      await writeFile(child, "not a directory");
      await expect(open(configured)).rejects.toMatchObject({ code: "ENOTDIR" });
      await expect(
        snapshotGhidraAnalysisSeeds(
          resolved.value,
          await workspace(),
          resources,
        ),
      ).rejects.toMatchObject({ _tag: "ProviderAdapterError" });
    },
  );

  it("reports an unreadable seed file as a provider error", async () => {
    const resolved = await resolveGhidraAnalysisSeeds(
      join(await workspace(), "absent.tsv"),
      resources,
    );
    if (resolved.ok) throw new Error("Expected an error");
    expect(projectAnalysisError(resolved.error)).toMatchObject({
      details: { diagnostics: { setting: "REA_GHIDRA_SEED_FILE" } },
    });
  });
});

describe("Ghidra seed session verification", () => {
  const commitment: GhidraSeedCommitment = {
    format: "rea-ghidra-seeds-v1",
    path: "/seeds.tsv",
    configured_path: "/seeds.tsv",
    sha256: "b".repeat(64),
    entries: { function: 2, code: 1, label: 1 },
  };
  const report: GhidraSeedReport = {
    format: "rea-ghidra-seeds-v1",
    sha256: "b".repeat(64),
    entries: 4,
    function_created: 1,
    function_existing: 0,
    function_failed: 1,
    code_decoded: 1,
    code_failed: 0,
    label_applied: 1,
    label_failed: 0,
    unmapped: 0,
  };

  it("rejects a handshake when the outcome counters account for too few or too many entries", () => {
    const expected = {
      runId: "d6fcbb66-e829-4ff6-a535-0035aec63139",
      providerVersion: "12.1.4",
      profileDigest: "a".repeat(64),
      targetSha256: "b".repeat(64),
    };
    const handshake = {
      name: "REA Ghidra bridge",
      run_id: expected.runId,
      profile_digest: expected.profileDigest,
      provider: { id: "ghidra", version: expected.providerVersion },
      read_only: false,
      analysis_complete: true,
      analysis_timed_out: false,
      capabilities: [...GHIDRA_SESSION_CAPABILITIES],
      target: {
        name: "fixture",
        language_id: "x86:LE:64:default",
        compiler_spec_id: "gcc",
        image_base: "0x0",
        default_address_space: "ram",
        sha256: expected.targetSha256,
      },
      analysis_seeds: report,
    };
    expect(parseGhidraSessionInfo(handshake, expected)).toMatchObject({
      ok: true,
      value: { analysis_seeds: report },
    });
    for (const function_created of [0, 100])
      expect(
        parseGhidraSessionInfo(
          {
            ...handshake,
            analysis_seeds: { ...report, function_created },
          },
          expected,
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "handshake_identity" },
      });
  });

  it.each([
    { function_created: 3, function_failed: 0, code_decoded: 0 },
    { function_created: 0, function_failed: 0, code_decoded: 3 },
    { function_created: 0, function_failed: 0, label_applied: 3 },
  ])(
    "rejects outcomes attributed to more seeds of a kind than committed: %j",
    (changed) => {
      const misattributed = { ...report, ...changed };
      expect(ghidraSeedReportSchema.safeParse(misattributed).success).toBe(
        true,
      );
      expect(
        ghidraSeedFailure(commitment, misattributed, "xrefs"),
      ).toBeDefined();
    },
  );

  it("admits producer outcomes including aggregate unmapped seeds without inventing their kinds", () => {
    for (const outcome of [
      report,
      {
        ...report,
        function_created: 0,
        function_failed: 0,
        code_decoded: 0,
        label_applied: 0,
        unmapped: 4,
      },
      { ...report, function_created: 0, code_decoded: 0, unmapped: 2 },
    ]) {
      expect(ghidraSeedReportSchema.safeParse(outcome).success).toBe(true);
      expect(ghidraSeedFailure(commitment, outcome, "xrefs")).toBeUndefined();
    }
  });

  it("accepts exactly the committed seeds and reports their outcome", () => {
    expect(ghidraSeedFailure(commitment, report, "xrefs")).toBeUndefined();
    expect(ghidraSeedFailure(undefined, undefined, "xrefs")).toBeUndefined();
    expect(ghidraSeedLimitations(commitment, report)).toEqual([
      expect.stringContaining("caller assertions, not Ghidra discoveries"),
      expect.stringContaining(
        "1 functions created, 0 already present, 1 failed",
      ),
    ]);
    expect(ghidraSeedLimitations(undefined)).toEqual([]);
  });

  it.each([
    ["a missing report", commitment, undefined],
    ["an uncommitted report", undefined, report],
    ["a different digest", commitment, { ...report, sha256: "c".repeat(64) }],
    [
      "a different count",
      commitment,
      { ...report, entries: 3, label_applied: 0 },
    ],
  ])("fails closed on %s", (_label, committed, reported) => {
    if (reported !== undefined)
      expect(ghidraSeedReportSchema.safeParse(reported).success).toBe(true);
    expect(ghidraSeedFailure(committed, reported, "xrefs")).toBeDefined();
  });
});

describe("Ghidra seed profile", () => {
  it("refuses a malformed seed file before launching Ghidra", async () => {
    const path = join(await workspace(), "seeds.tsv");
    await writeFile(path, "0x401000\tdata\n");
    const resolved = await resolveSeedProfile(path);
    if (resolved.ok) throw new Error("Expected a configuration error");
    expect(projectAnalysisError(resolved.error)).toMatchObject({
      code: "configuration_invalid",
      details: { settings: [{ setting: "REA_GHIDRA_SEED_FILE" }] },
    });
  });

  it("requires an absolute seed path", () => {
    const parsed = parseConfig({ REA_GHIDRA_SEED_FILE: "seeds.tsv" });
    expect(parsed.ok).toBe(false);
  });
});
