#!/usr/bin/env node
// Decode source-owned x86 bytes with the installed Ghidra, then run the bridge
// producer's frame/cleanup checks. The temporary project is isolated outside
// the checkout so failed verification cannot affect an analyst's database.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { cleanupOwnedProcessGroup } from "../dist/process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../dist/process/ProviderProcess.js";
import { createVerifierRun } from "./lib/verifier-run.mjs";

const install = process.env.GHIDRA_INSTALL_DIR;
if (!install) throw new Error("Set GHIDRA_INSTALL_DIR to Ghidra 12.1.4");
const root = resolve(import.meta.dirname, "..");
const run = createVerifierRun();

const scratch = await mkdtemp(
  join(
    existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir(),
    "rea-prototype-conflicts-",
  ),
);
let supervisor;
try {
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
  });
  supervisor = new ProviderProcessSupervisor(
    {
      ...launch,
      ownsProcessLifetime: true,
      cleanup: () => cleanupOwnedProcessGroup(launch.ownership),
    },
    { maxDiagnosticBytes: 8 * 1024 * 1024 },
  );
  assert.ok(
    await supervisor.waitForExit(180_000),
    "Ghidra prototype conflict probe timed out",
  );
  assert.ok(
    await supervisor.waitForOutputClose(1_000),
    "Ghidra prototype conflict probe output did not close",
  );
  const snapshot = supervisor.snapshot();
  const output = `${snapshot.stdout.text}\n${snapshot.stderr.text}`;
  assert.equal(snapshot.exitCode, 0, output);
  assert.match(output, /REA_PROTOTYPE_CONFLICT_OK/u, output.slice(-6000));
} finally {
  try {
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
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
console.log("REA_PROTOTYPE_CONFLICT_OK");
