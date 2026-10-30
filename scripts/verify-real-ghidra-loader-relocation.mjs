#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { inspectGhidraInstallation } from "../dist/ghidra/GhidraInstallation.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../dist/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../dist/process/ProcessOwnership.js";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";

const exec = promisify(execFile);
const expectedChecks = [
  "bridge_source_bound",
  "relocation_protection_precedes_decompiler",
  "fixture_is_elf_shared_object",
  "dynamic_elf_relocation_table_is_relocatable",
  "importer_relocation_present",
  "relocation_targets_pointer_symbol",
  "reader_references_relocation",
  "writer_references_relocation",
  "got_function_relocation_present",
  "got_data_relocation_present",
  "got_caller_references_loader_relocation",
  "destination_is_loaded_initialized",
  "destination_is_file_backed",
  "destination_is_non_writable",
  "destination_not_volatile_before_protection",
  "destination_block_is_volatile",
  "destination_permissions_preserved",
  "source_filebytes_unchanged",
  "evidence_limitation_represents_loader_uncertainty",
  "non_read_relocation_reference_not_reported_as_read",
  "relocation_lookup_covers_last_affected_byte",
  "got_relocations_are_volatile",
  "native_decompiler_available",
  "baseline_got_pseudocode_resolves_external_symbols",
  "protected_got_pseudocode_keeps_external_symbols",
  "full_relro_got_caller_pseudocode_is_stable",
];

if (process.argv.length !== 2)
  throw new Error(
    "Usage: node scripts/verify-real-ghidra-loader-relocation.mjs",
  );
if (process.platform !== "linux")
  throw new Error(
    "Loader-relocation verification requires a Linux Ghidra host with an ELF linker.",
  );
if (process.env.GHIDRA_INSTALL_DIR === undefined)
  throw new Error(
    "Set GHIDRA_INSTALL_DIR to a bring-your-own Ghidra installation.",
  );

const installation = inspectGhidraInstallation({
  environment: process.env,
  installDir: process.env.GHIDRA_INSTALL_DIR,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { javaHome: process.env.JAVA_HOME }),
});
assert.ok(
  installation.analyzeHeadlessPath !== null &&
    (installation.status === "available" ||
      installation.rejection?.code === "executable_missing"),
  JSON.stringify(installation),
);

const run = createVerifierRun();
const workspace = await mkdtemp(
  join(tmpdir(), "rea-ghidra-loader-relocation-"),
);
const project = join(workspace, "project");
const target = join(workspace, "rea-loader-relocation.elf");
const provider = join(workspace, "librea-loader-provider.so");
const fixture = fileURLToPath(
  new URL("../tests/conformance/ghidra/loader-relocation.c", import.meta.url),
);
const providerFixture = fileURLToPath(
  new URL(
    "../tests/conformance/ghidra/loader-relocation-provider.c",
    import.meta.url,
  ),
);
const bridgeDirectory = fileURLToPath(
  new URL("../bridge/ghidra", import.meta.url),
);
const fixtureDirectory = fileURLToPath(
  new URL("../tests/conformance/ghidra", import.meta.url),
);
const bridge = join(bridgeDirectory, "ReaGhidraBridge.java");
const compiler = process.env.REA_CC ?? "cc";
let supervisor;
let report;

try {
  await mkdir(project);
  await buildProvider(compiler, providerFixture, provider);
  await buildFixture(compiler, fixture, provider, target);
  const targetDigest = digest(await readFile(target));
  const launch = await spawnOwnedProviderProcess({
    command: installation.analyzeHeadlessPath,
    arguments: [
      project,
      "LoaderRelocation",
      "-import",
      target,
      "-readOnly",
      "-deleteProject",
      "-scriptPath",
      `${bridgeDirectory};${fixtureDirectory}`,
      "-postScript",
      "ReaLoaderRelocationProbe.java",
      bridge,
    ],
    runId: run.run_id,
    expectedCommand: null,
  });
  supervisor = new ProviderProcessSupervisor({
    ...launch,
    ownsProcessLifetime: true,
    cleanup: () => cleanupOwnedProcessGroup(launch.ownership),
  });
  assert.ok(
    await supervisor.waitForExit(180_000),
    "Ghidra loader-relocation probe exceeded its 180-second deadline",
  );
  const snapshot = supervisor.snapshot();
  const output = `${snapshot.stdout.text}\n${snapshot.stderr.text}`;
  assert.equal(snapshot.exitCode, 0, output);
  const matches = [
    ...output.matchAll(/REA_LOADER_RELOCATION_PROBE_JSON (\{[^\r\n]*\})/gu),
  ];
  assert.equal(matches.length, 1, output);
  report = JSON.parse(matches[0][1]);
  assert.equal(report.status, "passed");
  assert.equal(report.ghidra_version, installation.providerVersion);
  assert.deepEqual(
    expectedChecks.every((check) => report.checks.includes(check)),
    true,
  );
  assert.equal(report.source_filebytes_unchanged, true);
  assert.equal(report.permissions, "read=true,write=false,execute=false");
  assert.ok(
    report.limitations.some(
      (value) =>
        value.includes("non-writable block") &&
        value.includes("file-backed value may differ") &&
        value.includes("not authoritative"),
    ),
  );
  assert.equal(report.decompiler_verified, true);
  assert.ok(report.checks.includes("baseline_pseudocode_folds_file_constant"));
  assert.ok(report.checks.includes("pseudocode_does_not_use_file_constant"));
  assert.ok(
    report.checks.includes("protected_pseudocode_is_not_baseline_constant"),
  );
  assert.ok(
    report.checks.includes("full_relro_got_caller_pseudocode_is_stable"),
  );
  assert.equal(digest(await readFile(target)), targetDigest);
  report = {
    ...report,
    target_sha256: targetDigest,
    decompiler_scope:
      "native Ghidra baseline and protected pseudocode comparisons passed",
  };
} finally {
  if (supervisor !== undefined) {
    const stopped = await supervisor.stop();
    supervisor.dispose();
    assert.notEqual(stopped.status, "incomplete", JSON.stringify(stopped));
  }
  await rm(workspace, { recursive: true, force: true });
}

assert.ok(report);
console.log(
  JSON.stringify({
    ...report,
    cleanup: "complete",
    verifier_run: await completeVerifierRun(run),
  }),
);

async function buildProvider(compiler, source, output) {
  const arguments_ = [
    "-O0",
    "-fPIC",
    "-shared",
    "-nostdlib",
    source,
    "-o",
    output,
  ];
  await exec(compiler, arguments_, { timeout: 60_000 });
}

async function buildFixture(compiler, source, provider, output) {
  const arguments_ = [
    "-O0",
    "-fPIE",
    "-fno-plt",
    "-pie",
    "-nostdlib",
    "-Wl,-z,relro,-z,now",
    "-Wl,-e,rea_loader_start",
    "-Wl,-rpath,$ORIGIN",
    source,
    provider,
    "-o",
    output,
  ];
  await exec(compiler, arguments_, { timeout: 60_000 });
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
