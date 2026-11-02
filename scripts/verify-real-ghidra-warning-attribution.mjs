import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { projectNativeApiInspection } from "../dist/application/native/NativeApiInspection.js";
import { functionDossierSchema } from "../dist/domain/native/functionDossier.js";
import { nativeApiBoundarySchema } from "../dist/domain/native/nativeApiBoundary.js";
import { parseGhidraFunctionResult } from "../dist/ghidra/GhidraFunctionValues.js";
import { ghidraJavaEnvironment } from "../dist/ghidra/GhidraInstallation.js";
import { SUPPORTED_GHIDRA_VERSION } from "../dist/ghidra/GhidraReleasePolicy.js";
import { ghidraJavaLaunch } from "../dist/ghidra/GhidraJavaLaunch.js";
import { cleanupOwnedProcessGroup } from "../dist/process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../dist/process/ProviderProcess.js";
import {
  assertVerifierCleanupComplete,
  completeVerifierRun,
  createVerifierRun,
} from "./lib/verifier-run.mjs";
import { inspectVerifierGhidraInstallation } from "./lib/ghidra-installation-inspection.mjs";

assert.equal(process.argv.length, 2, "This verifier takes no arguments");
assert.ok(["linux", "darwin"].includes(process.platform));
const installation = await inspectVerifierGhidraInstallation({
  environment: process.env,
  installDir: process.env.GHIDRA_INSTALL_DIR,
  javaHome: process.env.JAVA_HOME,
});
assert.equal(installation.status, "available", JSON.stringify(installation));
assert.equal(installation.providerVersion, SUPPORTED_GHIDRA_VERSION);
const run = createVerifierRun();
const workspace = await mkdtemp(join(tmpdir(), "rea-ghidra-warning-"));
const bridgeDirectory = fileURLToPath(
  new URL("../bridge/ghidra", import.meta.url),
);
const bridge = join(bridgeDirectory, "ReaGhidraBridge.java");
const fixtures = fileURLToPath(
  new URL("../tests/conformance/ghidra", import.meta.url),
);
const sourceDigest = digest(await readFile(bridge));
let supervisor;
let cleaned = true;
let report;
try {
  for (const name of ["project", "home", "tmp"])
    await mkdir(join(workspace, name));
  const java = await ghidraJavaLaunch({
    platform: process.platform,
    analyzeHeadlessPath: installation.analyzeHeadlessPath,
    javaHome: installation.javaHome,
    javaVmName: installation.javaVmName,
    homeRoot: join(workspace, "home"),
    tempRoot: join(workspace, "tmp"),
    environment: ghidraJavaEnvironment(installation.javaHome, process.env),
    onStderr: (_phase, stderr) => process.stderr.write(stderr),
    arguments: [
      join(workspace, "project"),
      "WarningAttribution",
      "-scriptPath",
      `${fixtures};${bridgeDirectory}`,
      "-preScript",
      "ReaIndirectBranchEvidenceProbe.java",
      bridge,
      "-deleteProject",
    ],
  });
  const launch = await spawnOwnedProviderProcess({
    command: java.command,
    arguments: java.arguments,
    env: java.environment,
    runId: run.run_id,
  });
  cleaned = false;
  supervisor = new ProviderProcessSupervisor({
    ...launch,
    ownsProcessLifetime: true,
    cleanup: () => cleanupOwnedProcessGroup(launch.ownership),
  });
  assert.ok(await supervisor.waitForExit(180000), "Warning probe timed out");
  assert.ok(
    await supervisor.waitForOutputClose(1000),
    "Warning probe output did not close",
  );
  const snapshot = supervisor.snapshot();
  const output = `${snapshot.stdout.text}\n${snapshot.stderr.text}`;
  assert.equal(snapshot.exitCode, 0, output);
  const reports = [
    ...output.matchAll(/REA_INDIRECT_BRANCH_PROBE_JSON (\{[^\r\n]*\})/gu),
  ];
  assert.equal(reports.length, 1, output);
  assert.ok(output.includes("REA_INDIRECT_BRANCH_PROBE_COMPLETE"), output);
  report = JSON.parse(reports[0][1]);
  assert.equal(report.status, "passed");
  assert.equal(report.ghidra_version, SUPPORTED_GHIDRA_VERSION);
  assert.equal(report.bridge_source_sha256, sourceDigest);
  assert.deepEqual(
    report.cases.map(({ name }) => name),
    [
      "aarch64_default",
      "aarch64_overlay",
      "avr_word_addressed",
      "mips_delay_slot",
    ],
  );
  for (const observation of report.cases) {
    const boundary = nativeApiBoundarySchema.parse(observation.native_api);
    assert.equal(boundary.available, true);
    assert.equal(boundary.unresolved_indirect_branches.length, 1);
    assert.equal(
      boundary.unresolved_indirect_branches[0].branch_address,
      observation.branch_address,
    );
    assert.equal(
      boundary.unresolved_indirect_branches[0].decompiler_outcome,
      "jump_table_recovery_failed",
    );
    assert.deepEqual(
      boundary.unresolved_indirect_branches[0].listing_targets,
      [],
    );
    const printedCoordinate = {
      aarch64_default: "0x0000100c",
      aarch64_overlay: "0x0000100c",
      avr_word_addressed: "0x0804",
      mips_delay_slot: "0x08801008",
    }[observation.name];
    assert.ok(
      boundary.unresolved_indirect_branches[0].evidence.some(
        ({ source, detail }) =>
          source === "ghidra-decompiler-warning" &&
          detail.includes(
            `Could not recover jumptable at ${printedCoordinate}. Too many branches`,
          ),
      ),
    );
    if (observation.name === "avr_word_addressed") {
      assert.equal(observation.addressable_unit_bytes, 2);
      assert.equal(observation.dossier, undefined);
      continue;
    }
    const parsed = parseGhidraFunctionResult("analyze_function", {
      value: observation.dossier,
      limitations: [],
    });
    if (!parsed.ok) throw parsed.error;
    const dossier = functionDossierSchema.parse(parsed.value.value);
    assert.deepEqual(dossier.native_api, boundary);
    const inspection = projectNativeApiInspection(dossier);
    assert.deepEqual(inspection.boundary, dossier.native_api);
    assert.ok(
      inspection.unsupported_branches.includes(
        "indirect-branch-target-recovery",
      ),
    );
    assert.ok(
      inspection.residual_unknowns.some((unknown) =>
        unknown.startsWith(
          `Which targets can the indirect branch at ${observation.branch_address} reach?`,
        ),
      ),
    );
  }
  assert.equal(
    digest(await readFile(bridge)),
    sourceDigest,
    "Bridge source changed during verification",
  );
} finally {
  if (supervisor !== undefined) {
    const stopped = await supervisor.stop();
    supervisor.dispose();
    cleaned = stopped.status === "verified-cleanup";
    assert.ok(
      cleaned,
      `Owned cleanup incomplete; retained ${workspace}: ${JSON.stringify(stopped)}`,
    );
  }
  if (cleaned) await rm(workspace, { recursive: true, force: true });
}
const completed = await completeVerifierRun(run);
assertVerifierCleanupComplete(completed.process_lineage);
console.log(JSON.stringify({ ...report, ...completed }, null, 2));

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
