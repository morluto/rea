#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [, , lockName, ...command] = process.argv;
const lockRoot = resolve(process.cwd(), ".cache", "rea-command-locks");
const lockPath = join(lockRoot, `${lockName ?? "invalid"}.lock`);
const ownerPath = join(lockPath, "owner.json");
const signalExitCodes = { SIGINT: 130, SIGTERM: 143 };

let lockHeld = false;
let child;
let shutdownSignal;

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));

if (
  typeof lockName !== "string" ||
  !/^[a-z][a-z0-9-]*$/u.test(lockName) ||
  command.length === 0
) {
  console.error("Usage: run-exclusive.mjs <lock-name> <command> [args...]");
  process.exitCode = 64;
} else {
  await run();
}

async function run() {
  try {
    await acquireLock();
    const result = await runCommand();
    process.exitCode =
      shutdownSignal === undefined
        ? (result.code ?? 1)
        : signalExitCodes[shutdownSignal];
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  } finally {
    await releaseLock();
  }
}

async function acquireLock() {
  await mkdir(lockRoot, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(lockPath);
      await writeFile(
        ownerPath,
        JSON.stringify({
          pid: process.pid,
          command: command.join(" "),
          started_at: new Date().toISOString(),
        }),
        "utf8",
      );
      lockHeld = true;
      return;
    } catch (cause) {
      if (!isAlreadyExistsError(cause)) throw cause;
      const owner = await readOwner();
      if (owner === null || isProcessAlive(owner.pid))
        throw new Error(
          `Another ${lockName} command is already running (pid ${String(owner?.pid ?? "unknown")}). Wait for it to finish or inspect ${lockPath}.`,
        );
      await rm(lockPath, { force: true, recursive: true });
    }
  }
  throw new Error(`Could not acquire the ${lockName} command lock`);
}

async function releaseLock() {
  if (!lockHeld) return;
  lockHeld = false;
  try {
    const owner = await readOwner();
    if (owner?.pid === process.pid)
      await rm(lockPath, { force: true, recursive: true });
  } catch (cause) {
    console.error(
      `Could not remove the ${lockName} command lock: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function runCommand() {
  return new Promise((resolveResult, reject) => {
    child = spawn(command[0], command.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code }));
  });
}

function handleSignal(signal) {
  if (shutdownSignal !== undefined) return;
  shutdownSignal = signal;
  if (child !== undefined && child.exitCode === null) child.kill(signal);
}

async function readOwner() {
  try {
    const parsed = JSON.parse(await readFile(ownerPath, "utf8"));
    const pid =
      typeof parsed === "object" && parsed !== null
        ? Reflect.get(parsed, "pid")
        : undefined;
    if (typeof pid !== "number" || !Number.isInteger(pid)) return null;
    return { pid };
  } catch (cause) {
    if (isMissingFileError(cause)) return null;
    throw cause;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !isMissingProcessError(cause);
  }
}

function isAlreadyExistsError(cause) {
  return isNodeError(cause) && cause.code === "EEXIST";
}

function isMissingFileError(cause) {
  return isNodeError(cause) && cause.code === "ENOENT";
}

function isMissingProcessError(cause) {
  return isNodeError(cause) && cause.code === "ESRCH";
}

function isNodeError(cause) {
  return typeof cause === "object" && cause !== null && "code" in cause;
}
