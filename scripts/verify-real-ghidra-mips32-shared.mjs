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
import { buildMipsSharedFixture } from "../tests/conformance/ghidra/mips-fixture.mjs";
import {
  assertMipsSharedLoad,
  inspectMipsSharedReadelf,
  mipsSharedPlacementDelta,
} from "../tests/conformance/ghidra/mips-shared-checks.mjs";
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
import { completeEvidenceCliArguments } from "./lib/complete-evidence.mjs";
import { completeEvidenceClient } from "./lib/complete-evidence.mjs";

// Optional cross-target lane for plain MIPS32 PIC shared libraries (ET_DYN).
// No tool acquisition, no dynamic loading and no target execution.
if (process.argv.length > 2)
  throw new Error("Usage: node scripts/verify-real-ghidra-mips32-shared.mjs");
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
// Refuse a host without the fixture toolchain before allocating anything. The
// fixtures need the same Clang/LLD and GNU readelf as the mips lane.
await requireLaneToolchain("mips");
const workspaceFixture = await VerifierFixture.open({
  prefix: "rea-mips32-shared-proof-",
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

/** Read every word the oracle checks through the public read_bytes operation. */
async function loadedWords(call, independent, delta, byteOrder) {
  const addresses = new Set();
  for (const relocation of independent.relocations)
    if (relocation.type !== 0) addresses.add(relocation.address);
  const got = independent.dynamic.get("PLTGOT");
  const entries =
    independent.dynamic.get("MIPS_LOCAL_GOTNO") +
    independent.dynamic.get("MIPS_SYMTABNO") -
    independent.dynamic.get("MIPS_GOTSYM");
  for (let index = 0; index < entries; index += 1)
    addresses.add(got + index * 4);
  const words = new Map();
  for (const address of addresses) {
    const place = BigInt(address) + delta;
    const read = await call("read_bytes", {
      address: `0x${place.toString(16)}`,
      length: 4,
    });
    assert.equal(read.returned_bytes, 4, `read_bytes at ${place}`);
    const bytes = Buffer.from(read.bytes_hex, "hex");
    words.set(
      place,
      byteOrder === "little" ? bytes.readUInt32LE(0) : bytes.readUInt32BE(0),
    );
  }
  return words;
}

async function verifyFixture(byteOrder, softFloat) {
  const fixture = await buildMipsSharedFixture(
    workspace,
    byteOrder,
    softFloat,
    execOwned,
  );
  const independent = await inspectMipsSharedReadelf(
    fixture.path,
    byteOrder,
    fixture.float_abi,
    execOwned,
  );
  const resolved = await parseBinaryTarget(fixture.path);
  if (!resolved.ok) throw resolved.error;
  const { sharedLoad, ...declared } = resolved.value.mips;
  assert.deepEqual(
    declared,
    independent.mips,
    "REA ELF/ABI interpretation disagrees with GNU readelf",
  );
  const { loadAddresses, ...relocationFacts } = sharedLoad;
  assert.deepEqual(relocationFacts, {
    status: "complete",
    relocationCount: independent.relocations.length,
    relocationTypes: [
      ...new Set(independent.relocations.map((item) => item.type)),
    ].sort((left, right) => left - right),
    symbolRelativeCount: independent.relocations.filter(
      (item) => item.type === 3 && item.symbolIndex !== 0,
    ).length,
    prelinkBase: null,
  });
  // Every PT_LOAD, in header order; the fixture has fewer than 20 headers.
  assert.deepEqual(
    loadAddresses.map((load) => load.virtualAddress),
    independent.loads.map((load) => load.address),
    "REA PT_LOAD facts disagree with GNU readelf",
  );
  assert.ok(loadAddresses.every((load) => load.headerIndex < 20));
  assert.equal(resolved.value.sha256, fixture.sha256);
  const label = `${byteOrder}${softFloat ? "-soft-float" : ""}`;
  const snapshotPath = join(workspace, `${label}.snapshot.json`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env,
    stderr: "pipe",
  });
  const client = completeEvidenceClient(
    new Client({
      name: "rea-real-mips32-shared-proof",
      version: "1",
    }),
  );
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
    const names = await call("list_names");
    const fileBytes = await readFile(fixture.path);
    const delta = mipsSharedPlacementDelta(independent, image.mappings);
    // The lane loads at the ELF link base: addresses equal readelf's.
    assert.equal(delta, 0n, "Placement at the ELF link addresses");
    const coverage = assertMipsSharedLoad({
      facts: independent,
      fileBytes,
      mappings: image.mappings,
      ghidraRelocations: image.relocations,
      words: await loadedWords(call, independent, delta, byteOrder),
      names,
      byteOrder,
    });
    // The fixture's relocation and GOT shapes must all be exercised.
    assert.equal(coverage.rel32_local, 1, "Local REL32");
    assert.equal(coverage.rel32_defined, 1, "REL32 to an exported function");
    assert.equal(coverage.rel32_external, 1, "REL32 to an import");
    // Each slot is checked UNSUPPORTED with unchanged bytes by the oracle.
    assert.equal(coverage.tls, 3, "TLS DTPMOD32/DTPREL32/TPREL32 slots");
    assert.deepEqual(
      [
        ...new Set(
          independent.relocations
            .map((item) => item.type)
            .filter((type) => type >= 38),
        ),
      ].sort((left, right) => left - right),
      [38, 39, 47],
      "Fixture declares every admitted TLS relocation type",
    );
    assert.ok(coverage.got_defined > 0, "Global GOT entry for a definition");
    assert.ok(coverage.got_external >= 3, "Global GOT entries for imports");
    // Page entries for .text (zero in the file) and for the data segment.
    assert.equal(coverage.got_local, 2, "Local GOT page entries");
    assert.ok(
      coverage.got_local_zero > 0,
      "Zero-valued non-reserved GOT page entry",
    );
    const procedures = await call("list_procedures");
    const named = (name) => {
      const found = procedures.filter((item) => item.value === name);
      assert.equal(found.length, 1, `Procedure ${name}`);
      return found[0].address;
    };
    const entry = named("rea_mips_so_entry");
    const dossier = functionDossierSchema.parse(
      await call("analyze_function", { procedure: entry, detail: "complete" }),
    );
    // Calls through global GOT entries and the REL32 import pointer are named;
    // TLS goes through __tls_get_addr with the unapplied DTPMOD32 slot.
    assert.equal(
      dossier.pseudocode.match(/\brea_mips_so_external\(/gu)?.length,
      2,
      "Calls to the import through the GOT and through its REL32 pointer",
    );
    // The static call adds %lo to a zero-valued local GOT page entry.
    assert.match(dossier.pseudocode, /\brea_mips_so_local\(/u);
    // Ghidra prefixes "_" to globals that overlap smaller symbols.
    assert.match(dossier.pseudocode, /\b_?rea_mips_so_external_data\b/u);
    assert.match(dossier.pseudocode, /\b__tls_get_addr\(/u);
    assert.doesNotMatch(dossier.pseudocode, /\(\*\(code \*\)PTR_/u);
    // The pre-fix form: a call to the unrebased page entry plus %lo.
    assert.doesNotMatch(dossier.pseudocode, /\(\*\(code \*\)0x/u);
    assert.doesNotMatch(dossier.pseudocode, /\bin_f\d+\b/u);
    await call("close_binary", { snapshot_path: snapshotPath });
    const snapshot = parseAnalysisSnapshot(
      JSON.parse(await readFile(snapshotPath, "utf8")),
    );
    const parameters = snapshot.binding.analysis_profile.parameters;
    assert.equal(parameters.mips_elf.type, 3);
    assert.equal(
      parameters.mips_support_lane,
      "elf32-dyn-o32-arch32r2-standard",
    );
    assert.equal(parameters.mips_elf.shared_load.status, "complete");
    assert.deepEqual(parameters.elf_image_base, {
      offset: "0x0",
      selection: "elf-link-base",
    });
    assert.equal(
      parameters.mips_soft_float_storage,
      softFloat ? "o32-soft-float-prototype-v1" : undefined,
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
        ...(await completeEvidenceCliArguments([
          "function",
          fixture.path,
          "rea_mips_so_entry",
          "--provider",
          "ghidra",
          "--json",
        ])),
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
      "Analysis modified the source library",
    );
    return {
      ...fixture,
      independent_reader: {
        command: independent.command,
        version: independent.version,
      },
      effective_language: image.language_id,
      load_coverage: coverage,
      procedures: procedures.length,
      status: "passed",
    };
  } catch (cause) {
    throw new Error(
      `MIPS ${label} shared-library verification failed; MCP stderr: ${stderr}`,
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
  for (const [byteOrder, softFloat] of [
    ["little", false],
    ["big", false],
    ["little", true],
  ])
    reports.push(await verifyFixture(byteOrder, softFloat));
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
    `MIPS32 shared command cleanup failed; retained diagnostic workspace: ${workspace}`,
    {
      cause:
        primaryFailure === undefined
          ? cleanupFailure
          : new AggregateError(
              [primaryFailure, cleanupFailure],
              "MIPS32 shared verification and command cleanup both failed",
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
              "MIPS32 shared verification failed and cleanup was unverified",
            ),
    },
  );
if (primaryFailure !== undefined)
  throw retainWorkspace(
    `MIPS32 shared-library verification failed; retained workspace: ${workspace}`,
    { cause: primaryFailure },
  );
const interrupted = commandInterruption.reason();
if (interrupted !== undefined)
  throw retainWorkspace(
    `MIPS32 shared-library verification interrupted; retained diagnostic workspace: ${workspace}`,
    { cause: interrupted },
  );
commandInterruption.retainWorkspaceIfInterrupted(workspaceFixture);
await workspaceFixture.release();
const releaseInterrupted = finishCommandInterruption();
if (releaseInterrupted !== undefined) throw releaseInterrupted;
console.log(JSON.stringify({ ...completed, fixtures: reports }, null, 2));
