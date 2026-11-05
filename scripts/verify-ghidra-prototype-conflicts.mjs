#!/usr/bin/env node
// Decode source-owned x86 bytes with the installed Ghidra, then run the bridge
// producer's frame/cleanup checks. The temporary project is isolated outside
// the checkout so failed verification cannot affect an analyst's database.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

/** The one child this verifier owns; cleanup runs before scratch removal. */
let owned;

/**
 * Run analyzeHeadless in its own process group so the JVM and any decompiler
 * children are addressed as one owned family instead of an untracked tree.
 */
const runOwnedHeadless = (command, args, cwd) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    owned = child;
    let output = "";
    const collect = (chunk) => {
      output = `${output}${chunk}`.slice(-4 * 1024 * 1024);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const interrupt = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    child.on("error", rejectRun);
    child.on("close", (code) => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      if (code === 0) resolveRun(output);
      else
        rejectRun(
          new Error(`analyzeHeadless exited ${code}\n${output.slice(-6000)}`),
        );
    });
  });

/** Stop the owned process family and confirm nothing from it survives. */
const stopOwnedProcess = async () => {
  const child = owned;
  owned = undefined;
  if (child === undefined) return;
  const group = process.platform === "win32" ? undefined : -child.pid;
  const groupExists = () => {
    if (group === undefined) return child.exitCode === null;
    try {
      process.kill(group, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  const signal = (name) => {
    try {
      // Address the group so decompiler children cannot outlive the JVM.
      if (group === undefined) child.kill(name);
      else process.kill(group, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const waitForGroup = async (milliseconds) => {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      if (!groupExists()) return true;
      await new Promise((done) => setTimeout(done, 50));
    }
    return !groupExists();
  };
  if (!groupExists()) return;
  signal("SIGTERM");
  if (await waitForGroup(5_000)) return;
  signal("SIGKILL");
  if (!(await waitForGroup(2_000)))
    throw new Error("Owned Ghidra process group remained after SIGKILL");
};

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
  const output = await runOwnedHeadless(
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
    scratch,
  );
  assert.match(output, /REA_PROTOTYPE_CONFLICT_OK/u, output.slice(-6000));
} finally {
  await stopOwnedProcess();
  await rm(scratch, { recursive: true, force: true });
}
console.log("REA_PROTOTYPE_CONFLICT_OK");
