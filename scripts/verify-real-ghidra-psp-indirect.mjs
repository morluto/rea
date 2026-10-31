#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
const execute = promisify(execFile);
const workspace = await mkdtemp(join(tmpdir(), "rea-psp-indirect-"));
const runtime = join(workspace, "runtime");
const origin = fileURLToPath(
  new URL("../tests/conformance/psp/control-flow/", import.meta.url),
);
const script = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const names = [
  ["computed_dispatch", "rea_psp_computed_dispatch", 8, "jr"],
  ["indirect_tail", "rea_psp_indirect_tail", 4, "jr"],
  ["return_control", "rea_psp_return_control", 4, "jr"],
  ["direct_control", "rea_psp_direct_control", 0, "j"],
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let report;
let client;
let transport;
let stderr = "";
try {
  await mkdir(runtime);
  const sourceDigests = {};
  for (const filename of ["Makefile", "main.c", "control-flow.S"]) {
    const source = await readFile(join(origin, filename));
    sourceDigests[filename] = digest(source);
    await copyFile(join(origin, filename), join(workspace, filename));
  }

  const subprocess = (command, args, timeout = 60000) =>
    execute(command, args, {
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
  await client.connect(transport);
  transport.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-65536);
  });
  const call = async (name, args = {}) => {
    const reply = await client.callTool(
      { name, arguments: args },
      { timeout: 240000 },
    );
    const value = requireMcpOperationResult(reply, name);
    const evidence = ["inspect_native_api", "analyze_function"].includes(name)
      ? parseEvidence(reply.structuredContent)
      : undefined;
    return { value, evidence };
  };

  await call("open_binary", { path: targetPath, provider_id: "ghidra" });
  const image = (await call("inspect_native_load_image")).value;
  assertPspLoadedImage(image.observations, targetSha);
  const procedures = (await call("list_procedures")).value;
  const observed = [];
  let computedListingBranches = 0;
  let preservedComputedBranches = 0;
  let originalDispatchInspection;
  for (const [label, symbol, offset, expectedMnemonic] of names) {
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

    const functionResult = await call("analyze_function", { procedure: entry });
    assert.ok(functionResult.evidence?.evidence_id);
    const inspection = await call("inspect_native_api", { procedure: entry });
    assert.ok(inspection.evidence?.evidence_id);
    const nativeApi = inspection.value;
    if (label === "computed_dispatch") originalDispatchInspection = nativeApi;
    const boundary = nativeApi.boundary;
    const branches = boundary.available
      ? (boundary.unresolved_indirect_branches ?? [])
      : [];
    const unresolved = branches.find(
      (b) => BigInt(b.branch_address) === BigInt(address),
    );
    const recovered = boundary.available
      ? boundary.jump_tables.some(
          (t) => BigInt(t.dispatch_address) === BigInt(address),
        )
      : false;
    const computed = listing.flow.kind === "jump" && listing.flow.computed;
    if (computed) {
      computedListingBranches++;
      assert.equal(
        boundary.available,
        true,
        "Computed jump native API boundary unavailable: " + symbol,
      );
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
      unavailable_reason: boundary.available ? null : boundary.reason,
      decompiler_pseudocode_nonempty:
        typeof functionResult.value.pseudocode === "string" &&
        functionResult.value.pseudocode.length > 0,
      unresolved_indirect_branches: branches,
      recovered_jump_table_addresses: boundary.available
        ? boundary.jump_tables.map((table) => table.dispatch_address)
        : [],
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
  assert.equal(snapshot.target.sha256, targetSha);
  assert.equal(
    snapshot.binding.analysis_profile.parameters.language_id,
    "Allegrex:LE:32:default",
  );
  assert.ok(snapshot.evidence_bundle.records.length > 0);
  for (const row of snapshot.evidence_bundle.records)
    assert.equal(parseEvidence(row).subject?.digest.sha256, targetSha);

  await call("open_binary", {
    path: targetPath,
    provider_id: "ghidra",
    snapshot_path: snapshotPath,
  });
  const replayed = (
    await call("inspect_native_api", {
      procedure: symbols.rea_psp_computed_dispatch,
    })
  ).value;
  assert.ok(originalDispatchInspection, "Original API result missing");
  assert.deepEqual(replayed, originalDispatchInspection);
  assert.ok(Array.isArray(replayed.residual_unknowns));
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
  throw error;
} finally {
  if (client !== undefined) await client.close();
  if (transport !== undefined) await transport.close();
  await rm(workspace, { recursive: true, force: true });
}
const completed = await completeVerifierRun(run);
assertVerifierCleanupComplete(completed.process_lineage);
assert.ok(report, "Missing PSP indirect branch report");
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
