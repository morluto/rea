#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseBinaryTarget } from "../dist/application/BinaryTargetResolver.js";
import { parseAnalysisSnapshot } from "../dist/domain/analysisSnapshot.js";
import { parseEvidence } from "../dist/domain/evidence.js";
import { functionDossierSchema } from "../dist/domain/native/functionDossier.js";
import { inspectVerifierGhidraInstallation } from "./lib/ghidra-installation-inspection.mjs";
import { buildLoongArchFixture } from "../tests/conformance/ghidra/loongarch-fixture.mjs";
import {
  analysisAddressOffset,
  assertLoongArchGlobalBytes,
  assertLoongArchLoadedImage,
  assertLoongArchProbeBytes,
  assertLoongArchProbeInstructions,
  assertLoongArchProbePseudocode,
  inspectLoongArchReadelf,
} from "../tests/conformance/ghidra/loongarch-checks.mjs";
import { requireMcpOperationResult } from "./lib/mcp-verifier-results.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";

// Optional cross-target lane. No tool acquisition and no target execution.
if (process.argv.length !== 2)
  throw new Error("Usage: node scripts/verify-real-ghidra-loongarch.mjs");
if (!["linux", "darwin"].includes(process.platform))
  throw new Error(
    "This optional verifier requires POSIX process lineage for owned cleanup",
  );
if (process.env.GHIDRA_INSTALL_DIR === undefined)
  throw new Error("Missing prerequisite: caller-supplied GHIDRA_INSTALL_DIR");
const installation = await inspectVerifierGhidraInstallation({
  environment: process.env,
  installDir: process.env.GHIDRA_INSTALL_DIR,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { javaHome: process.env.JAVA_HOME }),
});
if (installation.status !== "available")
  throw new Error(
    `Ghidra prerequisite unavailable: ${JSON.stringify(installation)}`,
  );
const execute = promisify(execFile);
const entrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const run = createVerifierRun();
const workspace = await mkdtemp(join(tmpdir(), "rea-loongarch-proof-"));
const runtime = join(workspace, "runtime");
await mkdir(runtime);
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  TMPDIR: runtime,
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "ghidra",
  REA_PROCESS_RUN_ID: run.run_id,
  GHIDRA_INSTALL_DIR: installation.installDir,
  JAVA_HOME: installation.javaHome,
  HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
};
for (const setting of ["GHIDRA_HEADLESS_MAXMEM", "GHIDRA_MAXMEM"])
  if (process.env[setting] !== undefined) env[setting] = process.env[setting];
const reports = [];
let primaryFailure;
try {
  const fixture = await buildLoongArchFixture(workspace);
  const shared = await inspectLoongArchReadelf(fixture.shared.path, {
    type: 3,
    flags: 0x43,
  });
  const oldWorld = await inspectLoongArchReadelf(fixture.old_world.path, {
    type: 3,
    flags: 0x3,
  });
  const executable = await inspectLoongArchReadelf(fixture.executable.path, {
    type: 2,
    flags: 0x43,
  });
  assert.ok(
    (shared.relocations.R_LARCH_64 ?? 0) > 0 &&
      (shared.relocations.R_LARCH_JUMP_SLOT ?? 0) > 0,
    "Fixture does not declare the dynamic relocations this lane verifies",
  );
  for (const [path, independent] of [
    [fixture.shared.path, shared],
    [fixture.old_world.path, oldWorld],
    [fixture.executable.path, executable],
  ]) {
    const resolved = await parseBinaryTarget(path);
    if (!resolved.ok) throw resolved.error;
    assert.equal(resolved.value.architecture, "loongarch");
    assert.deepEqual(
      resolved.value.loongarch,
      independent.loongarch,
      "REA ELF interpretation disagrees with GNU readelf",
    );
  }
  assert.equal(oldWorld.loongarch.objectAbiVersion, 0);
  assert.equal(shared.loongarch.objectAbiVersion, 1);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "rea-real-loongarch-proof", version: "1" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-65536);
  });
  const call = async (name, args = {}) => {
    const reply = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 300000,
    });
    return requireMcpOperationResult(reply, name);
  };
  try {
    await client.connect(transport);
    const target = await call("open_binary", {
      path: fixture.shared.path,
      provider_id: "ghidra",
    });
    assert.equal(target.architecture, "loongarch");
    assert.equal(target.sha256, fixture.shared.sha256);
    const image = await call("inspect_native_load_image");
    assertLoongArchLoadedImage(image.observations, fixture.shared.sha256);
    assert.equal(image.observations.compiler_spec_id, "default");
    assert.ok(
      image.observations.relocations.some(
        (relocation) =>
          relocation.type === 2 && relocation.status === "APPLIED",
      ),
      "Ghidra did not apply the fixture's R_LARCH_64 relocation",
    );
    assert.ok(
      image.observations.relocations.some(
        (relocation) =>
          relocation.type === 5 && relocation.status === "APPLIED",
      ),
      "Ghidra did not apply the fixture's R_LARCH_JUMP_SLOT relocation",
    );

    const names = await call("list_names");
    const probeName = names.find(
      (item) => item.value === "rea_loongarch_probe",
    );
    const globalName = names.find(
      (item) => item.value === "rea_loongarch_global",
    );
    assert.ok(probeName, "Probe symbol is missing from the real inventory");
    assert.ok(globalName, "Global symbol is missing from the real inventory");
    // A shared image's coordinates are its analysis image base plus the ELF
    // virtual address readelf reports, not the runtime load address.
    const imageBase = analysisAddressOffset(image.observations.image_base);
    assert.equal(
      analysisAddressOffset(probeName.address),
      imageBase + BigInt(shared.symbols.rea_loongarch_probe),
    );
    assert.equal(
      analysisAddressOffset(globalName.address),
      imageBase + BigInt(shared.symbols.rea_loongarch_global),
    );
    const probeBytes = await call("read_bytes", {
      address: probeName.address,
      length: 12,
    });
    assert.equal(probeBytes.returned_bytes, 12);
    assertLoongArchProbeBytes(probeBytes.bytes_hex);
    const globalBytes = await call("read_bytes", {
      address: globalName.address,
      length: 4,
    });
    assert.equal(globalBytes.returned_bytes, 4);
    assertLoongArchGlobalBytes(globalBytes.bytes_hex);

    const instructions = await call("read_function_instructions", {
      procedure: "rea_loongarch_probe",
    });
    assertLoongArchProbeInstructions(
      instructions.instructions,
      probeName.address,
    );
    const pseudocode = await call("procedure_pseudo_code", {
      procedure: "rea_loongarch_probe",
    });
    assertLoongArchProbePseudocode(pseudocode);
    const dossier = functionDossierSchema.parse(
      await call("analyze_function", {
        procedure: "rea_loongarch_probe",
        detail: "complete",
      }),
    );
    assert.equal(dossier.procedure.address, probeName.address);
    assert.ok(dossier.assembly.length > 0);

    const sharedSnapshotPath = join(workspace, "loongarch.snapshot.json");
    const closed = await call("close_binary", {
      snapshot_path: sharedSnapshotPath,
    });
    assert.ok(closed.evidence_records > 0);
    const snapshot = parseAnalysisSnapshot(
      JSON.parse(await readFile(sharedSnapshotPath, "utf8")),
    );
    assert.equal(snapshot.target.architecture, "loongarch");
    assert.equal(
      snapshot.binding.analysis_profile.parameters.language_id,
      "Loongarch:LE:64:lp64d",
    );
    assert.match(
      String(
        snapshot.binding.analysis_profile.parameters.loongarch_support_lane,
      ),
      /^elf64-le-dyn-lp64d-objabi-v1-/u,
    );
    assert.ok(snapshot.evidence_bundle.records.length > 0);
    for (const evidence of snapshot.evidence_bundle.records)
      assert.equal(parseEvidence(evidence).subject?.architecture, "loongarch");
    await call("open_binary", {
      path: fixture.shared.path,
      provider_id: "ghidra",
      snapshot_path: sharedSnapshotPath,
    });
    assert.deepEqual(await call("list_names"), names);
    await call("close_binary");

    for (const [item, lane] of [
      [fixture.old_world, "elf64-le-dyn-lp64d-objabi-v0-generic-v1"],
      [fixture.executable, "elf64-le-exec-lp64d-objabi-v1-generic-v1"],
    ]) {
      const snapshotPath = join(
        workspace,
        `${item.sha256.slice(0, 12)}.snapshot.json`,
      );
      const opened = await call("open_binary", {
        path: item.path,
        provider_id: "ghidra",
      });
      assert.equal(opened.architecture, "loongarch");
      const loaded = await call("inspect_native_load_image");
      assertLoongArchLoadedImage(loaded.observations, item.sha256);
      const saved = await call("close_binary", { snapshot_path: snapshotPath });
      assert.ok(saved.evidence_records > 0);
      const laneSnapshot = parseAnalysisSnapshot(
        JSON.parse(await readFile(snapshotPath, "utf8")),
      );
      assert.equal(
        laneSnapshot.binding.analysis_profile.parameters.language_id,
        "Loongarch:LE:64:lp64d",
      );
      assert.equal(
        laneSnapshot.binding.analysis_profile.parameters.loongarch_support_lane,
        lane,
      );
    }

    // Same public operation through the CLI, not a private injected provider.
    const cli = await execute(
      process.execPath,
      [
        entrypoint,
        "function",
        fixture.shared.path,
        "rea_loongarch_probe",
        "--provider",
        "ghidra",
        "--json",
      ],
      { env, timeout: 300000, maxBuffer: 16 * 1024 * 1024 },
    );
    const evidence = parseEvidence(JSON.parse(cli.stdout));
    assert.equal(evidence.subject?.architecture, "loongarch");
    assert.equal(evidence.subject?.digest.sha256, fixture.shared.sha256);
    const cliDossier = functionDossierSchema.parse(evidence.normalized_result);
    assert.equal(cliDossier.procedure.address, probeName.address);
    assert.ok(cliDossier.pseudocode.trim().length > 0);
    assert.equal(
      createHash("sha256")
        .update(await readFile(fixture.shared.path))
        .digest("hex"),
      fixture.shared.sha256,
      "Analysis modified the source executable",
    );

    reports.push({
      ...fixture,
      independent_reader: {
        command: shared.command,
        version: shared.version,
        shared: shared.loongarch,
        old_world: oldWorld.loongarch,
        executable: executable.loongarch,
        relocations: shared.relocations,
      },
      effective_language: image.observations.language_id,
      effective_compiler_spec: image.observations.compiler_spec_id,
      checks: [
        "independent ELF headers, symbols and relocations",
        "new-world, old-world and fixed-address lane identity",
        "loaded Ghidra identity and pinned LP64D language",
        "applied R_LARCH_64 and R_LARCH_JUMP_SLOT fixups",
        "fixed probe instruction bytes and listing text",
        "relocated global bytes",
        "constant-folded probe pseudocode",
        "CLI/MCP and snapshot identity",
      ],
      status: "passed",
    });
  } catch (cause) {
    throw new Error(`LoongArch verification failed; MCP stderr: ${stderr}`, {
      cause,
    });
  } finally {
    try {
      await client.close();
    } finally {
      await transport.close();
    }
  }
} catch (cause) {
  primaryFailure = cause;
}
const completed = await completeVerifierRun(run);
if (
  completed.process_lineage.status !== "verified" ||
  completed.process_lineage.descendants.length !== 0
)
  throw new Error(
    `Cleanup unverified; retained diagnostic workspace: ${workspace}`,
    { cause: primaryFailure },
  );
if (primaryFailure !== undefined)
  throw new Error(
    `LoongArch verification failed; retained workspace: ${workspace}`,
    { cause: primaryFailure },
  );
await rm(workspace, { recursive: true, force: true });
console.log(JSON.stringify({ ...completed, fixtures: reports }, null, 2));
