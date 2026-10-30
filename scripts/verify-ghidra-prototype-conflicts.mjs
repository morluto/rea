#!/usr/bin/env node
// Decode source-owned x86 bytes with the installed Ghidra, then run the bridge
// producer's frame/cleanup checks. The temporary project is isolated outside
// the checkout so failed verification cannot affect an analyst's database.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

const install = process.env.GHIDRA_INSTALL_DIR;
if (!install) throw new Error("Set GHIDRA_INSTALL_DIR to Ghidra 12.1.4");
const root = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(
  join(
    existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir(),
    "rea-prototype-conflicts-",
  ),
);
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
  const image = Buffer.alloc(0x800, 0xcc);
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
  ]) {
    Buffer.from(hex, "hex").copy(image, offset);
  }
  const imagePath = join(scratch, "instructions.bin");
  await writeFile(imagePath, image);
  const output = execFileSync(
    join(install, "support/analyzeHeadless"),
    [
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
    { encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
  );
  assert.match(output, /REA_PROTOTYPE_CONFLICT_OK/u, output.slice(-6000));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.log("REA_PROTOTYPE_CONFLICT_OK");
