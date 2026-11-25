import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parseConfig } from "../dist/config/parseConfig.js";
import { inspectVerifierGhidraInstallation } from "./lib/ghidra-installation-inspection.mjs";
import { SUPPORTED_GHIDRA_VERSION } from "../dist/ghidra/GhidraReleasePolicy.js";
import { cleanupOwnedProcessGroup } from "../dist/process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../dist/process/ProviderProcess.js";
import {
  VerifierFixture,
  withVerifierFixture,
} from "./lib/verifier-fixture.mjs";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";

const exec = promisify(execFile);
const run = createVerifierRun();
assert.ok(
  process.platform === "linux" || process.platform === "darwin",
  "This regression lane requires Linux or macOS",
);
const config = parseConfig(process.env);
if (!config.ok) throw config.error;
const installation = await inspectVerifierGhidraInstallation({
  environment: process.env,
  installDir: config.value.ghidraInstallDir,
  javaHome: config.value.ghidraJavaHome,
});
assert.equal(installation.status, "available", JSON.stringify(installation));
assert.equal(installation.providerVersion, SUPPORTED_GHIDRA_VERSION);
const fixtures = fileURLToPath(
  new URL("../tests/conformance/ghidra", import.meta.url),
);
const bridge = fileURLToPath(new URL("../bridge/ghidra", import.meta.url));
const clang = process.env.REA_CLANG ?? "clang";
const formats = [
  "elf",
  ...(process.platform === "darwin" && process.arch === "arm64"
    ? ["mach-o"]
    : []),
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Ghidra's headless launcher writes projects beneath the workspace, so it is a
// plain temporary root. It is removed only after every owned Ghidra process
// confirms cleanup; otherwise it is retained and named.
const fixture = await VerifierFixture.open({
  prefix: "rea-ghidra-warning-",
  private: false,
});
const workspace = fixture.path;

/**
 * Run one headless probe as an owned process and return the one JSON report
 * it prints after `${marker}_JSON `.
 */
async function runProbe(label, project, args, marker) {
  await mkdir(project);
  const launch = await spawnOwnedProviderProcess({
    command: installation.analyzeHeadlessPath,
    arguments: [project, ...args],
    runId: run.run_id,
    expectedCommand: null,
  });
  const supervisor = new ProviderProcessSupervisor({
    ...launch,
    ownsProcessLifetime: true,
    cleanup: () => cleanupOwnedProcessGroup(launch.ownership),
  });
  fixture.releaseAfter(async () => {
    const stopped = await supervisor.stop();
    assert.equal(
      stopped.status,
      "verified-cleanup",
      `${label} cleanup could not be verified: ${JSON.stringify(stopped)}`,
    );
  });
  assert.ok(await supervisor.waitForExit(180000), `${label} timed out`);
  assert.ok(
    await supervisor.waitForOutputClose(1000),
    `${label} output did not close`,
  );
  const snapshot = supervisor.snapshot();
  const output = `${snapshot.stdout.text}\n${snapshot.stderr.text}`;
  assert.equal(snapshot.exitCode, 0, output);
  const found = [
    ...output.matchAll(new RegExp(`${marker}_JSON (\\{[^\\r\\n]*\\})`, "gu")),
  ];
  assert.equal(found.length, 1, output);
  const probe = JSON.parse(found[0][1]);
  assert.equal(probe.status, "passed");
  assert.equal(probe.ghidra_version, SUPPORTED_GHIDRA_VERSION);
  return probe;
}

const verify = async () => {
  const bridgeDigest = digest(
    await readFile(join(bridge, "ReaGhidraBridge.java")),
  );
  const targets = [];
  for (const format of formats) {
    const targetPath = join(workspace, `removed-block-${format}.o`);
    await exec(clang, [
      ...(format === "elf" ? ["--target=aarch64-linux-gnu"] : []),
      "-c",
      join(fixtures, "decompiler-removed-block.S"),
      "-o",
      targetPath,
    ]);
    const targetDigest = digest(await readFile(targetPath));
    const probe = await runProbe(
      `${format} warning provenance probe`,
      join(workspace, `project-${format}`),
      [
        "WarningProvenance",
        "-import",
        targetPath,
        "-readOnly",
        "-deleteProject",
        "-scriptPath",
        `${fixtures};${bridge}`,
        "-postScript",
        join(fixtures, "ReaDecompilerWarningProvenanceProbe.java"),
        bridge,
      ],
      "REA_WARNING_PROVENANCE_PROBE",
    );
    assert.equal(probe.target_sha256, targetDigest);
    assert.equal(probe["ReaGhidraBridge.java"], bridgeDigest);
    for (const check of [
      "baseline_real_removal",
      "plate_decoy_rendered_as_header",
      "plate_decoy_not_recorded",
      "plate_decoy_no_omission_limitation",
      "plate_decoy_comment_retained",
      "plate_unmapped_decoy_not_recorded",
      "body_comment_decoy_not_recorded",
      "body_comment_decoy_retained",
      "repeated_warning_rendered_twice",
      "repeated_warning_keeps_real_removal",
    ])
      assert.ok(probe.checks.includes(check), `${format}: ${check}`);
    assert.equal(digest(await readFile(targetPath)), targetDigest);
    targets.push({
      format,
      removed_start: probe.removed_start,
      body_comment_rendered_in_pseudocode:
        probe.body_comment_rendered_in_pseudocode,
      checks: probe.checks,
    });
  }

  // Removal-warning coordinates on address spaces no source-built object
  // reaches, through the production bridge with no import.
  const coordinates = await runProbe(
    "removed-block coordinate probe",
    join(workspace, "project-coordinates"),
    [
      "RemovedBlockCoordinates",
      "-scriptPath",
      `${fixtures};${bridge}`,
      "-preScript",
      join(fixtures, "ReaDecompilerRemovedBlockCoordinateProbe.java"),
      join(bridge, "ReaGhidraBridge.java"),
      "-deleteProject",
    ],
    "REA_REMOVED_BLOCK_COORDINATE_PROBE",
  );
  assert.equal(coordinates.bridge_source_sha256, bridgeDigest);
  for (const check of [
    "overlay_removal_dropped_start",
    "overlay_removal_listing_block",
    "default_removal_dropped_start",
    "default_removal_listing_block",
    "colliding_overlay_removal_dropped_start",
    "colliding_overlay_removal_listing_block",
    "unknown_space_removal_dropped_start",
    "register_space_removal_dropped_start",
    "outside_body_removal_listing_block",
    "avr_two_byte_addressable_unit",
    "avr_word_removal_dropped_start",
    "avr_word_removal_listing_block",
    "avr_word_removal_raw_offset",
  ])
    assert.ok(coordinates.checks.includes(check), `coordinates: ${check}`);
  return {
    targets,
    removed_block_coordinates: {
      avr_word_removal_start: coordinates.avr_word_removal_start,
      checks: coordinates.checks,
    },
  };
};

const result = await withVerifierFixture(fixture, verify);
console.log(
  JSON.stringify({
    status: "passed",
    ...result,
    scope:
      "Real Ghidra AArch64 ELF (and Mach-O on Apple Silicon) objects with caller-authored entry plate and body comments, through the production bridge's analyze_function observation, plus removal-warning coordinates on synthetic overlay, colliding, unknown, register and AVR word-addressed spaces, each fed one typed header warning token. Plate comments cannot be set through REA's public tools, so this lane drives the bridge in-process; no target execution.",
    cleanup: "complete",
    verifier_run: await completeVerifierRun(run),
  }),
);
