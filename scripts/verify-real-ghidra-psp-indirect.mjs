#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseEvidence } from "../dist/domain/evidence.js";
import { parseAnalysisSnapshot } from "../dist/domain/analysisSnapshot.js";
import { parseBinaryTarget } from "../dist/application/BinaryTargetResolver.js";
import { inspectVerifierGhidraInstallation } from "./lib/ghidra-installation-inspection.mjs";
import {
  parsePspReadelfMips,
  assertPspLoadedImage,
} from "../tests/conformance/ghidra/psp-fixture.mjs";
import { requireMcpOperationResult } from "./lib/mcp-verifier-results.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";
import { bindVerifierCommandInterruption } from "./lib/verifier-command-interruption.mjs";
import { VerifierFixture } from "./lib/verifier-fixture.mjs";
import {
  createVerifierRun,
  completeVerifierRun,
  assertVerifierCleanupComplete,
} from "./lib/verifier-run.mjs";

// Test only synthesized source-owned static ELF. This verifier never executes it.
if (process.platform !== "linux" || process.argv.length !== 2)
  throw new Error(
    "PSP computed-branch verification requires Linux and no arguments",
  );
if (!process.env.GHIDRA_INSTALL_DIR || !process.env.PSPDEV)
  throw new Error("Caller must supply a compatible Ghidra/Allegrex and PSPDEV");

const ghidra = await inspectVerifierGhidraInstallation({
  environment: process.env,
  installDir: process.env.GHIDRA_INSTALL_DIR,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { javaHome: process.env.JAVA_HOME }),
});
if (ghidra.status !== "available")
  throw new Error("Ghidra prerequisite unavailable: " + JSON.stringify(ghidra));

const run = createVerifierRun();
const commands = await createVerifierCommands();
const fixture = await VerifierFixture.open({ prefix: "rea-psp-indirect-" });
const interruption = bindVerifierCommandInterruption(commands);
const workspace = fixture.path;
const runtime = join(workspace, "runtime");
const origin = fileURLToPath(
  new URL("../tests/conformance/psp/control-flow/", import.meta.url),
);
const script = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const names = [
  ["computed_dispatch", "rea_psp_computed_dispatch", 8, "jr", "jump", true],
  ["indirect_tail", "rea_psp_indirect_tail", 4, "jr", "jump", true],
  ["return_control", "rea_psp_return_control", 4, "jr", "return", false],
  ["direct_control", "rea_psp_direct_control", 0, "j", "jump", false],
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let report;
let client;
let transport;
let stderr = "";
const failures = [];
try {
  await mkdir(runtime);
  const sourceDigests = {};
  for (const filename of ["Makefile", "main.c", "control-flow.S"]) {
    const source = await readFile(join(origin, filename));
    sourceDigests[filename] = digest(source);
    await copyFile(join(origin, filename), join(workspace, filename));
  }

  const subprocess = (command, args, timeout = 60000) =>
    interruption.exec(command, args, {
      cwd: workspace,
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
  const toolVersions = {};
  for (const name of ["psp-gcc", "psp-readelf", "psp-objdump", "make"])
    toolVersions[name] = (await subprocess(name, ["--version"], 10000)).stdout
      .trim()
      .split("\n")[0];
  await subprocess("make", ["rea_psp_indirect.elf"], 120000);
  const targetPath = join(workspace, "rea_psp_indirect.elf");
  const original = await readFile(targetPath);
  const targetSha = digest(original);
  assert.equal(original.toString("hex", 0, 6), "7f454c460101");
  assert.equal(original.readUInt16LE(16), 2);
  assert.equal(original.readUInt16LE(18), 8);
  assert.equal(original.readUInt32LE(36), 0x10a23001);

  const elf = (
    await subprocess("psp-readelf", ["-h", "-SW", "-A", "-sW", targetPath])
  ).stdout;
  assert.match(elf, /Class:\s+ELF32/u);
  assert.match(elf, /Type:\s+EXEC\b/u);
  assert.match(elf, /Flags:\s+0x10a23001\b/u);
  const independentMips = parsePspReadelfMips(elf);
  const symbols = {};
  for (const [, name] of names) {
    const rows = elf
      .split("\n")
      .map((line) => line.trim().split(/\s+/u))
      .filter((row) => row.length === 8 && row[7] === name);
    assert.equal(
      rows.length,
      1,
      "Independently declared function symbol missing: " + name,
    );
    assert.equal(rows[0][3], "FUNC");
    assert.equal(rows[0][4], "GLOBAL");
    symbols[name] = "0x" + Number.parseInt(rows[0][1], 16).toString(16);
    const asm = (
      await subprocess("psp-objdump", [
        "-d",
        "--disassemble=" + name,
        targetPath,
      ])
    ).stdout;
    assert.match(asm, /\bjr\b|\bj\b/u);
  }
  const parsed = await parseBinaryTarget(targetPath);
  if (!parsed.ok) throw parsed.error;
  assert.equal(parsed.value.sha256, targetSha);
  assert.equal(parsed.value.mips.flags, 0x10a23001);
  assert.deepEqual(parsed.value.mips, independentMips);

  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: runtime,
    GHIDRA_INSTALL_DIR: ghidra.installDir,
    JAVA_HOME: ghidra.javaHome,
    REA_LOG_LEVEL: "silent",
    REA_ANALYSIS_PROVIDER: "ghidra",
    REA_PROCESS_RUN_ID: run.run_id,
    HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
  };
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [script, "mcp"],
    env,
    stderr: "pipe",
  });
  client = new Client({ name: "rea-psp-indirect-proof", version: "1" });
  await interruption.untilInterrupted(
    client.connect(transport, { signal: interruption.signal }),
  );
  transport.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-65536);
  });
  const call = async (name, args = {}) => {
    interruption.throwIfInterrupted();
    const reply = await client.callTool(
      { name, arguments: args },
      { timeout: 240000, signal: interruption.signal },
    );
    const value = requireMcpOperationResult(reply, name);
    const evidence =
      name === "inspect_native_api" || name === "list_procedures"
        ? parseEvidence(reply.structuredContent)
        : undefined;
    return { value, evidence };
  };

  await call("open_binary", { path: targetPath, provider_id: "ghidra" });
  const image = (await call("inspect_native_load_image")).value;
  assertPspLoadedImage(image.observations, targetSha);
  const documents = (await call("list_documents")).value;
  assert.equal(documents.length, 1);
  const [document] = documents;
  assert.ok(typeof document === "string" && document.length > 0);
  const inventoryArguments = { document, detail: "complete" };
  const procedures = (await call("list_procedures", inventoryArguments)).value;
  const observed = [];
  let computedListingBranches = 0;
  let preservedComputedBranches = 0;
  let originalDispatchInspection;
  for (const [
    label,
    symbol,
    offset,
    expectedMnemonic,
    flowKind,
    computed,
  ] of names) {
    const entry = symbols[symbol];
    assert.ok(
      procedures.some(
        (p) => p.value === symbol && BigInt(p.address) === BigInt(entry),
      ),
      "Real Ghidra inventory omitted symbol " + symbol,
    );
    const address = "0x" + (BigInt(entry) + BigInt(offset)).toString(16);
    const listing = (await call("inspect_native_instruction", { address }))
      .value;
    assert.equal(listing.status, "decoded");
    assert.match(
      listing.mnemonic,
      new RegExp("^" + expectedMnemonic + "$", "iu"),
    );
    assert.equal(listing.flow.kind, flowKind, "Wrong flow kind: " + symbol);
    assert.equal(
      listing.flow.computed,
      computed,
      "Wrong computed flag: " + symbol,
    );

    const inspection = await call("inspect_native_api", { procedure: entry });
    assert.ok(inspection.evidence?.evidence_id);
    const nativeApi = inspection.value;
    if (label === "computed_dispatch") originalDispatchInspection = nativeApi;
    const boundary = nativeApi.boundary;
    assert.equal(
      boundary.available,
      true,
      "Native API boundary unavailable: " + symbol,
    );
    const branches = boundary.unresolved_indirect_branches;
    assert.ok(
      Array.isArray(branches),
      "Unresolved branch inspection missing: " + symbol,
    );
    const unresolved = branches.find(
      (b) => BigInt(b.branch_address) === BigInt(address),
    );
    const recovered = boundary.jump_tables.some(
      (table) => BigInt(table.dispatch_address) === BigInt(address),
    );
    if (computed) {
      computedListingBranches++;
      assert.equal(
        recovered,
        false,
        "Synthetic unbounded jump unexpectedly became a recovered switch: " +
          symbol,
      );
      assert.ok(
        unresolved,
        "Indirect branch was omitted from unresolved inventory: " + symbol,
      );
      assert.equal(
        branches.length,
        1,
        "Expected exactly one unresolved jump for " + symbol,
      );
      assert.deepEqual(
        unresolved.listing_targets,
        [],
        "Computed branch unexpectedly has listing targets: " + symbol,
      );
      assert.ok(
        unresolved.evidence.some(
          (item) =>
            item.kind === "indirect-branch" && item.source === "ghidra-listing",
        ),
      );
      assert.ok(
        nativeApi.residual_unknowns.some((unknown) =>
          unknown.includes(address),
        ),
        "Unresolved reachability unknown omitted: " + symbol,
      );
      assert.ok(
        nativeApi.unsupported_branches.includes(
          "indirect-branch-target-recovery",
        ),
      );
      assert.ok(
        ["jump_table_recovery_failed", "no_jump_table_warning"].includes(
          unresolved.decompiler_outcome,
        ),
      );
      preservedComputedBranches++;
    } else {
      assert.equal(
        branches.length,
        0,
        "Ordinary control was misclassified as unresolved: " + symbol,
      );
    }
    observed.push({
      label,
      symbol,
      address,
      mnemonic: listing.mnemonic,
      flow: listing.flow,
      boundary_available: boundary.available,
      unavailable_reason: null,
      unresolved_indirect_branches: branches,
      recovered_jump_table_addresses: boundary.jump_tables.map(
        (table) => table.dispatch_address,
      ),
      unsupported_branches: nativeApi.unsupported_branches,
      residual_unknowns: nativeApi.residual_unknowns,
      evidence_id: inspection.evidence.evidence_id,
    });
  }
  assert.equal(
    computedListingBranches,
    2,
    "Fixture must yield both computed-jump listing controls",
  );
  assert.equal(
    preservedComputedBranches,
    2,
    "Computed branches must retain unresolved targets and unknowns",
  );

  const snapshotPath = join(workspace, "rea-psp-control-flow.snapshot.json");
  await call("close_binary", { snapshot_path: snapshotPath });
  const snapshot = parseAnalysisSnapshot(
    JSON.parse(await readFile(snapshotPath, "utf8")),
  );
  assert.equal(snapshot.target.kind, "executable");
  assert.equal(snapshot.target.identity.kind, "file");
  assert.equal(snapshot.target.identity.sha256, targetSha);
  assert.equal(
    snapshot.binding.analysis_profile.parameters.language_id,
    "Allegrex:LE:32:default",
  );
  assert.ok(snapshot.evidence_bundle.records.length > 0);
  for (const row of snapshot.evidence_bundle.records) {
    const { identity } = parseEvidence(row).subject;
    assert.equal(identity.kind, "file");
    assert.equal(identity.sha256, targetSha);
  }

  await call("open_binary", {
    path: targetPath,
    provider_id: "ghidra",
    snapshot_path: snapshotPath,
  });
  const replayed = await call("list_procedures", inventoryArguments);
  assert.ok(
    replayed.evidence?.limitations.some((limitation) =>
      limitation.includes("Loaded from a local REA analysis snapshot"),
    ),
    "Expected procedure inventory Evidence replayed from the saved snapshot",
  );
  assert.deepEqual(replayed.value, procedures);

  const freshInspection = await call("inspect_native_api", {
    procedure: symbols.rea_psp_computed_dispatch,
  });
  assert.ok(originalDispatchInspection, "Original API result missing");
  assert.deepEqual(freshInspection.value, originalDispatchInspection);
  assert.ok(Array.isArray(freshInspection.value.residual_unknowns));
  await call("close_binary");
  assert.equal(digest(await readFile(targetPath)), targetSha);

  report = {
    status: "passed",
    mode: "PSP/Allegrex unresolved indirect-branch conformance",
    feature_pr: 2977,
    provider_uncertainty_coverage_established: true,
    ghidra_version: ghidra.providerVersion,
    mips_elf: independentMips,
    original_sha256: targetSha,
    source_sha256: sourceDigests,
    symbol_entries: symbols,
    compiler_versions: toolVersions,
    effective_language_id: image.observations.language_id,
    computed_listing_branches: computedListingBranches,
    unresolved_computed_branches: preservedComputedBranches,
    controls: observed,
    snapshot_evidence_records: snapshot.evidence_bundle.records.length,
    snapshot_profile_digest: snapshot.binding.analysis_profile.digest,
    source_bytes_unchanged: true,
  };
} catch (error) {
  if (stderr.length > 0) console.error(stderr);
  failures.push(error);
} finally {
  try {
    await fixture.closeEarly([
      () => client?.close(),
      () => transport?.close(),
      () => commands.close(),
    ]);
  } catch (error) {
    failures.push(error);
  }
}
let completed;
try {
  try {
    completed = await completeVerifierRun(run);
    assertVerifierCleanupComplete(completed.process_lineage);
  } catch (error) {
    failures.push(error);
  }
  const interrupted = interruption.reason();
  if (interrupted !== undefined && !failures.includes(interrupted))
    failures.push(interrupted);
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      `PSP verifier failed; retained workspace: ${workspace}`,
    );
  assert.ok(report, "Missing PSP indirect branch report");
  interruption.retainWorkspaceIfInterrupted(fixture);
  await fixture.release();
  interruption.throwIfInterrupted();
} finally {
  interruption.finish();
}
process.stdout.write(
  JSON.stringify(
    {
      verifier_run: completed,
      ...report,
      cleanup: "complete",
    },
    null,
    2,
  ) + "\n",
);
