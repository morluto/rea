#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Run Vitest under the owned process-group supervisor on POSIX so an
// interrupted run reaps detached provider children with the test tree.
// Windows source tests must not require the built Job Object artifact, so
// they invoke Vitest directly, as in run-development-tests.mjs.
const vitest = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
);
const arguments_ = ["run", ...process.argv.slice(2)];
const wrap = process.platform !== "win32";
const child = spawn(
  process.execPath,
  wrap
    ? [
        fileURLToPath(new URL("./run-exclusive.mjs", import.meta.url)),
        "--unlocked",
        process.execPath,
        vitest,
        ...arguments_,
      ]
    : [vitest, ...arguments_],
  { stdio: "inherit" },
);

const signalExitCodes = { SIGINT: 130, SIGTERM: 143 };
let receivedSignal;
for (const signal of Object.keys(signalExitCodes))
  process.on(signal, () => {
    // Forward even when wrapped: run-exclusive can only forward signals it
    // receives itself, not ones delivered solely to this launcher PID.
    receivedSignal ??= signal;
    child.kill(signal);
  });

child.once("error", (cause) => {
  console.error(cause.message);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  process.exitCode =
    receivedSignal !== undefined
      ? signalExitCodes[receivedSignal]
      : signal !== null && signal in signalExitCodes
        ? signalExitCodes[signal]
        : (code ?? 1);
});
