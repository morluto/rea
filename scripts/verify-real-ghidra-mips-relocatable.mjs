#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseBinaryTarget } from "../dist/application/BinaryTargetResolver.js";
import { parseEvidence } from "../dist/domain/evidence.js";
import { parseAnalysisSnapshot } from "../dist/domain/analysisSnapshot.js";
import { functionDossierSchema } from "../dist/domain/native/functionDossier.js";
import { inspectVerifierGhidraInstallation } from "./lib/ghidra-installation-inspection.mjs";
import { buildMipsRelocatableFixture } from "../tests/conformance/ghidra/mips-fixture.mjs";
import {
  assertMipsRelocations,
  inspectMipsRelocatableReadelf,
} from "../tests/conformance/ghidra/mips-relocatable-checks.mjs";
import { requireMcpOperationResult } from "./lib/mcp-verifier-results.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";
import { bindVerifierCommandInterruption } from "./lib/verifier-command-interruption.mjs";
import {
  assertVerifierCleanupComplete,
  createVerifierRun,
  completeVerifierRun,
} from "./lib/verifier-run.mjs";
import { VerifierFixture } from "./lib/verifier-fixture.mjs";
import { requireLaneToolchain } from "../tests/conformance/ghidra/fixture-toolchain.mjs";

// Optional cross-target lane for ET_REL objects. No tool acquisition, no
// linking and no target execution.
if (process.argv.length > 2)
  throw new Error(
    "Usage: node scripts/verify-real-ghidra-mips-relocatable.mjs",
  );
if (!["linux", "darwin"].includes(process.platform))
  throw new Error(
    "MIPS verification requires a supported Linux/macOS Ghidra host",
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
const entrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const run = createVerifierRun();
// Refuse a host without the fixture toolchain before allocating anything.
await requireLaneToolchain("mips-relocatable");
const workspaceFixture = await VerifierFixture.open({
  prefix: "rea-mips-rel-proof-",
  // Ghidra children use the workspace as TMPDIR; a plain root admits them on every host.
  private: false,
});
const workspace = workspaceFixture.path;
// A failed run keeps its workspace for diagnosis; the fixture records why.
const retainWorkspace = (message, options) => {
  workspaceFixture.retain(message);
  return new Error(message, options);
};
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
for (const setting of ["GHIDRA_HEADLESS_MAXMEM", "GHIDRA_MAXMEM"]) {
  if (process.env[setting] !== undefined) env[setting] = process.env[setting];
}
// The public CLI launch uses this command owner. A timeout stops its process group.
const commands = await createVerifierCommands();
const commandInterruption = bindVerifierCommandInterruption(commands);
const execOwned = commandInterruption.exec;
const { untilInterrupted, throwIfInterrupted } = commandInterruption;
const finishCommandInterruption = () => commandInterruption.finish();

/** Load every relocated word through the public read_bytes operation. */
async function loadedWords(call, independent, segments, byteOrder) {
  const words = new Map();
  for (const relocation of independent.relocations) {
    const section = [...independent.sections.values()].find(
      (item) => item.name === relocation.section,
    );
    if (!section?.allocated) continue;
    const segment = segments.find((item) => item.name === section.name);
    assert.ok(segment, `Ghidra segment ${section.name}`);
    const address = BigInt(segment.start) + BigInt(relocation.offset);
    const read = await call("read_bytes", {
      address: `0x${address.toString(16)}`,
      length: 4,
    });
    assert.equal(read.returned_bytes, 4);
    const bytes = Buffer.from(read.bytes_hex, "hex");
    words.set(
      address,
      byteOrder === "little" ? bytes.readUInt32LE(0) : bytes.readUInt32BE(0),
    );
  }
  return words;
}

async function verifyFixture(byteOrder, kernelModule) {
  const fixture = await buildMipsRelocatableFixture(
    workspace,
    byteOrder,
    kernelModule,
  );
  const independent = await inspectMipsRelocatableReadelf(
    fixture.path,
    byteOrder,
    fixture.float_abi,
  );
  const resolved = await parseBinaryTarget(fixture.path);
  if (!resolved.ok) throw resolved.error;
  assert.deepEqual(
    resolved.value.mips,
    independent.mips,
    "REA ELF/ABI interpretation disagrees with GNU readelf",
  );
  assert.equal(resolved.value.sha256, fixture.sha256);
  const label = `${byteOrder}${kernelModule ? "-module" : ""}`;
  const snapshotPath = join(workspace, `${label}.snapshot.json`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "rea-real-mips-rel-proof", version: "1" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-65536);
  });
  const call = async (name, args = {}) => {
    throwIfInterrupted();
    return requireMcpOperationResult(
      await client.callTool(
        { name, arguments: args },
        { timeout: 180000, signal: commandInterruption.signal },
      ),
      name,
    );
  };
  try {
    await untilInterrupted(
      client.connect(transport, { signal: commandInterruption.signal }),
    );
    const target = await call("open_binary", {
      path: fixture.path,
      provider_id: "ghidra",
    });
    assert.equal(target.architecture, "mips");
    assert.equal(target.sha256, fixture.sha256);
    const image = (await call("inspect_native_load_image")).observations;
    assert.equal(
      image.language_id,
      `MIPS:${byteOrder === "little" ? "LE" : "BE"}:32:default`,
    );
    assert.equal(image.source_files.length, 1);
    assert.equal(image.source_files[0].original_sha256, fixture.sha256);
    assert.notEqual(
      image.source_files[0].modified_sha256,
      fixture.sha256,
      "Relocations must change the loaded bytes",
    );
    const names = await call("list_names");
    const segments = await call("list_segments");
    const coverage = assertMipsRelocations({
      facts: independent,
      fileBytes: await readFile(fixture.path),
      segments,
      mappings: image.mappings,
      ghidraRelocations: image.relocations,
      words: await loadedWords(call, independent, segments, byteOrder),
      names,
      byteOrder,
    });
    assert.equal(coverage.unplaced, 0, "Fixture references an empty section");
    assert.ok(coverage.shared_hi16, "No HI16 shared by several LO16s");
    assert.ok(coverage.multiple_hi16, "No LO16 resolved several pending HI16s");
    assert.ok(coverage.lo16_carry, "No LO16 >= 0x8000 forced a HI16 carry");
    assert.ok(coverage.external_code, "No external code relocation");
    assert.ok(coverage.external_data, "No external data relocation");
    assert.ok(coverage.types.R_MIPS_32 > 0, "No R_MIPS_32 relocation");
    assert.equal(
      coverage.types.R_MIPS_26 === undefined,
      kernelModule,
      "Long calls must replace every R_MIPS_26 with HI16/LO16",
    );
    const procedures = await call("list_procedures");
    const named = (name) => {
      const found = procedures.filter((item) => item.value === name);
      assert.equal(found.length, 1, `Procedure ${name}`);
      return found[0].address;
    };
    const entry = named("rea_mips_rel_entry");
    const callees = await call("procedure_callees", { procedure: entry });
    for (const callee of [
      named("rea_mips_rel_leaf"),
      named("rea_mips_rel_far"),
    ])
      assert.ok(callees.includes(callee), `Missing direct call to ${callee}`);
    // Ghidra lists the external function and its EXTERNAL-block thunk.
    assert.ok(
      procedures.some(
        (item) =>
          item.value === "<EXTERNAL>::rea_mips_rel_external" &&
          callees.includes(item.address),
      ),
      "Missing call to the external function",
    );
    const dossier = functionDossierSchema.parse(
      await call("analyze_function", { procedure: entry, detail: "complete" }),
    );
    for (const name of [
      "rea_mips_rel_leaf",
      "rea_mips_rel_far",
      "rea_mips_rel_external",
    ])
      assert.ok(dossier.pseudocode.includes(name), `Pseudocode lost ${name}`);
    // powf's float prototype comes from Ghidra's C library archive; soft-float
    // builds pass 1.5f/2.5f in $a0/$a1, hard-float builds in $f12/$f14.
    const scaled = functionDossierSchema.parse(
      await call("analyze_function", {
        procedure: named("rea_mips_rel_scaled"),
        detail: "complete",
      }),
    );
    assert.match(scaled.pseudocode, /\bpowf\(1\.5,2\.5\)/u);
    assert.doesNotMatch(scaled.pseudocode, /\bin_f\d+\b/u);
    await call("close_binary", { snapshot_path: snapshotPath });
    const snapshot = parseAnalysisSnapshot(
      JSON.parse(await readFile(snapshotPath, "utf8")),
    );
    const parameters = snapshot.binding.analysis_profile.parameters;
    assert.equal(parameters.mips_elf.type, 1);
    assert.equal(
      parameters.mips_support_lane,
      "elf32-rel-o32-arch32r2-standard",
    );
    assert.equal(
      parameters.mips_soft_float_storage,
      kernelModule ? "o32-soft-float-prototype-v1" : undefined,
    );
    assert.ok(
      snapshot.evidence_bundle.records.some((record) =>
        parseEvidence(record).limitations.some((item) =>
          item.includes("Relocatable MIPS ELF"),
        ),
      ),
      "Relocatable limitation missing from retained Evidence",
    );
    assert.equal(
      snapshot.evidence_bundle.records.some((record) =>
        parseEvidence(record).limitations.some((item) =>
          /Soft-float prototype outcome: [1-9]\d* functions/u.test(item),
        ),
      ),
      kernelModule,
      "Soft-float prototype must cover the archive-typed external in module builds",
    );
    await call("open_binary", {
      path: fixture.path,
      provider_id: "ghidra",
      snapshot_path: snapshotPath,
    });
    assert.deepEqual(await call("list_procedures"), procedures);
    await call("close_binary");
    // Same public operation through CLI, not a private injected provider.
    const cli = await execOwned(
      process.execPath,
      [
        entrypoint,
        "function",
        fixture.path,
        "rea_mips_rel_entry",
        "--provider",
        "ghidra",
        "--json",
      ],
      { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
    );
    const evidence = parseEvidence(JSON.parse(cli.stdout));
    assert.equal(evidence.subject?.identity.architecture, "mips");
    assert.equal(evidence.subject?.identity.sha256, fixture.sha256);
    assert.equal(
      functionDossierSchema.parse(evidence.normalized_result).procedure.address,
      dossier.procedure.address,
    );
    assert.equal(
      createHash("sha256")
        .update(await readFile(fixture.path))
        .digest("hex"),
      fixture.sha256,
      "Analysis modified the source object",
    );
    return {
      ...fixture,
      independent_reader: {
        command: independent.command,
        version: independent.version,
      },
      effective_language: image.language_id,
      relocation_coverage: coverage,
      procedures: procedures.length,
      status: "passed",
    };
  } catch (cause) {
    throw new Error(
      `MIPS ${label} relocatable verification failed; MCP stderr: ${stderr}`,
      { cause },
    );
  } finally {
    try {
      await client.close();
    } finally {
      await transport.close();
    }
  }
}

const reports = [];
let primaryFailure;
try {
  for (const [byteOrder, kernelModule] of [
    ["little", false],
    ["big", false],
    ["little", true],
  ])
    reports.push(await verifyFixture(byteOrder, kernelModule));
} catch (cause) {
  primaryFailure = cause;
}
// Close the command owner before the parent-tree check. A failed close stays
// registered for retry and the diagnostic workspace is retained.
let cleanupFailure;
try {
  await workspaceFixture.closeEarly([() => commands.close()]);
} catch (cause) {
  cleanupFailure = cause;
}
if (cleanupFailure !== undefined)
  throw retainWorkspace(
    `MIPS relocatable command cleanup failed; retained diagnostic workspace: ${workspace}`,
    {
      cause:
        primaryFailure === undefined
          ? cleanupFailure
          : new AggregateError(
              [primaryFailure, cleanupFailure],
              "MIPS relocatable verification and command cleanup both failed",
            ),
    },
  );
const completed = await completeVerifierRun(run);
let lineageFailure;
try {
  assertVerifierCleanupComplete(completed.process_lineage);
} catch (cause) {
  lineageFailure = cause;
}
if (lineageFailure !== undefined)
  throw retainWorkspace(
    `Cleanup unverified; retained diagnostic workspace: ${workspace}`,
    {
      cause:
        primaryFailure === undefined
          ? lineageFailure
          : new AggregateError(
              [primaryFailure, lineageFailure],
              "MIPS relocatable verification failed and cleanup was unverified",
            ),
    },
  );
if (primaryFailure !== undefined)
  throw retainWorkspace(
    `MIPS relocatable verification failed; retained workspace: ${workspace}`,
    { cause: primaryFailure },
  );
const interrupted = commandInterruption.reason();
if (interrupted !== undefined)
  throw retainWorkspace(
    `MIPS relocatable verification interrupted; retained diagnostic workspace: ${workspace}`,
    { cause: interrupted },
  );
await workspaceFixture.release();
const releaseInterrupted = finishCommandInterruption();
if (releaseInterrupted !== undefined) throw releaseInterrupted;
console.log(JSON.stringify({ ...completed, fixtures: reports }, null, 2));
