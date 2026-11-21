#!/usr/bin/env node
// Decode source-owned x86 bytes with the installed Ghidra, then run the bridge
// producer's frame/cleanup checks. The temporary project is isolated outside
// the checkout so failed verification cannot affect an analyst's database.
import assert from "node:assert/strict";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { cleanupOwnedProcessGroup } from "../dist/process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../dist/process/ProviderProcess.js";
import { verifierFailureReasons } from "./lib/verifier-cleanup.mjs";
import {
  VerifierFixture,
  withVerifierFixture,
} from "./lib/verifier-fixture.mjs";
import { createVerifierRun } from "./lib/verifier-run.mjs";

const install = process.env.GHIDRA_INSTALL_DIR;
if (!install) throw new Error("Set GHIDRA_INSTALL_DIR to Ghidra 12.1.4");
const root = resolve(import.meta.dirname, "..");
const run = createVerifierRun();

// The fixture owns the workspace root: Ghidra's headless launcher writes the
// project beneath it, so it is a plain temporary root, and it is removed only
// after the owned process confirms cleanup — otherwise it is retained and
// named for diagnosis.
const fixture = await VerifierFixture.open({
  prefix: "rea-prototype-conflicts-",
  private: false,
});
const scratch = fixture.path;
const controller = new AbortController();
let interruptHandler;
const interrupted = new Promise((resolve) => {
  interruptHandler = (signal) => {
    controller.abort(new Error(`${signal} requested`));
    resolve(false);
  };
});
const handleSigint = () => interruptHandler("SIGINT");
const handleSigterm = () => interruptHandler("SIGTERM");
process.on("SIGINT", handleSigint);
process.on("SIGTERM", handleSigterm);
let supervisor;
let cleanupStep = "owned process cleanup";
fixture.releaseAfter(async () => {
  if (supervisor !== undefined) {
    const stopped = await supervisor.stop();
    assert.equal(
      stopped.status,
      "verified-cleanup",
      `Ghidra process cleanup could not be verified: ${
        "reason" in stopped ? stopped.reason : String(stopped.status)
      }`,
    );
  }
  cleanupStep = "temporary workspace deletion";
});
const probe = async () => {
  const project = join(scratch, "project");
  await mkdir(project);
  const scripts = join(scratch, "scripts");
  await mkdir(scripts);
  for (const name of await readdir(join(root, "bridge/ghidra"))) {
    if (name.endsWith(".java"))
      await copyFile(join(root, "bridge/ghidra", name), join(scripts, name));
  }
  await copyFile(
    join(root, "tests/conformance/ghidra/ReaPrototypeConflictProbe.java"),
    join(scripts, "ReaPrototypeConflictProbe.java"),
  );
  const image = Buffer.alloc(0x0b00, 0xcc);
  for (const [offset, hex] of [
    // JNE skips the early LEAVE; RET and reaches MOV ECX, [EBP + 8].
    [0x000, "5589e583f8007502c9c38b4d08c9c3"],
    [0x100, "5589e587e88b4d08c9c3"], // XCHG EAX, EBP
    [0x200, "5589e56689c58b4d08c9c3"], // MOV BP, AX
    [0x300, "5589e58b4d08c9c3"],
    [0x400, "c20800"], // RET 8
    [0x500, "c20000"], // RET 0
    [0x600, "5589e58b6d088b4d08c9c3"], // MOV EBP,[EBP+8], then a stale-frame read
    [0x700, "5589e58f4508c9c3"], // POP [EBP+8] reads [ESP], not the destination
    [0x800, "5589e58b4d08c9c3"], // Entry frame whose owned block sits below it.
    [0xa00, "90c3"], // A decoded lower block that precedes the entry in the scan.
  ]) {
    Buffer.from(hex, "hex").copy(image, offset);
  }
  const imagePath = join(scratch, "instructions.bin");
  await writeFile(imagePath, image);
  const launch = await spawnOwnedProviderProcess({
    command: join(install, "support/analyzeHeadless"),
    arguments: [
      project,
      "PrototypeConflicts",
      "-import",
      imagePath,
      "-loader",
      "BinaryLoader",
      "-loader-baseAddr",
      "0x1000",
      "-processor",
      "x86:LE:32:default",
      "-noanalysis",
      "-readOnly",
      "-scriptPath",
      scripts,
      "-postScript",
      "ReaPrototypeConflictProbe.java",
    ],
    runId: run.run_id,
    expectedCommand: null,
    cwd: scratch,
    env: { JAVA_HOME: process.env.JAVA_HOME },
    signal: controller.signal,
  });
  supervisor = new ProviderProcessSupervisor(
    {
      ...launch,
      ownsProcessLifetime: true,
      cleanup: () => cleanupOwnedProcessGroup(launch.ownership),
    },
    { maxDiagnosticBytes: 8 * 1024 * 1024 },
  );
  const exited = await Promise.race([
    supervisor.waitForExit(180_000),
    interrupted,
  ]);
  if (controller.signal.aborted)
    throw new Error(
      "Ghidra prototype conflict probe interrupted by SIGINT/SIGTERM",
    );
  assert.ok(exited, "Ghidra prototype conflict probe timed out");
  assert.ok(
    await supervisor.waitForOutputClose(1_000),
    "Ghidra prototype conflict probe output did not close",
  );
  const snapshot = supervisor.snapshot();
  const output = `${snapshot.stdout.text}\n${snapshot.stderr.text}`;
  assert.equal(snapshot.exitCode, 0, output);
  assert.match(output, /REA_PROTOTYPE_CONFLICT_OK/u, output.slice(-6000));
};

try {
  // The shared owner releases the fixture only after the registered cleanup
  // confirms. A combined failure keeps the probe error as its cause and the
  // retained root as its cleanup lease, so neither failure nor the owner of
  // an unsafe tree is dropped from the error the caller receives.
  await withVerifierFixture(fixture, probe);
} catch (cause) {
  if (!fixture.released) {
    // Retain cleanup diagnostics and possible evidence instead of replacing
    // the cleanup failure with an interruption or deleting an unsafe tree.
    console.error(
      `Ghidra verifier failed during ${cleanupStep}: ${verifierFailureReasons(
        cause,
      ).join("; ")}`,
    );
    if (cleanupStep !== "temporary workspace deletion")
      console.error(
        `Retained failed Ghidra verification project at ${scratch}`,
      );
  }
  throw cause;
} finally {
  // Keep cleanup handlers installed until release has finished, so an
  // interrupt cannot terminate the verifier before its owner resumes.
  process.off("SIGINT", handleSigint);
  process.off("SIGTERM", handleSigterm);
}
if (controller.signal.aborted)
  throw new Error(
    "Ghidra prototype conflict probe interrupted by SIGINT/SIGTERM",
  );
console.log("REA_PROTOTYPE_CONFLICT_OK");
