import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  developmentTestPlan,
  parseDevelopmentTestRequest,
} from "./lib/development-tests.mjs";

let child;
let forceTimer;
let shutdownSignal;
const signalExitCodes = { SIGINT: 130, SIGTERM: 143 };
for (const signal of Object.keys(signalExitCodes))
  process.on(signal, () => {
    if (shutdownSignal !== undefined) return;
    shutdownSignal = signal;
    if (child !== undefined && child.exitCode === null) {
      child.kill(signal);
      forceTimer = setTimeout(() => child?.kill("SIGKILL"), 1_000);
      forceTimer.unref?.();
    }
  });

try {
  const [mode, ...arguments_] = process.argv.slice(2);
  const request = parseDevelopmentTestRequest(mode, arguments_);
  for (const path of request.paths) {
    if (!(await stat(path)).isFile())
      throw new Error(`Test path is not a file: ${path}`);
  }
  let baseCommit;
  if (request.mode === "changed") {
    const base = await run("git", ["merge-base", "HEAD", request.base], true);
    if (base.code !== 0)
      throw new Error(
        `Cannot resolve test base ${request.base}. Fetch origin/main or pass --base REVISION.\n${base.output.trim()}`,
      );
    baseCommit = base.output.trim();
  }
  const plan = developmentTestPlan(request, baseCommit);
  if (request.dryRun) {
    console.log(JSON.stringify({ ...request, baseCommit, ...plan }, null, 2));
  } else {
    console.error(
      request.mode === "focused"
        ? `Focused tests: ${request.paths.join(", ")}`
        : `Source-test feedback${baseCommit ? ` from merge base ${baseCommit}` : ""}; compiled boundaries and real providers need explicit verification.`,
    );
    if (plan.needsBuild || plan.artifactTasks.length > 0) {
      const dependencies = await run(process.execPath, [
        "scripts/check-dependency-install.mjs",
      ]);
      if (dependencies.code !== 0)
        throw new Error(
          "Test prerequisites require the locked dependency installation",
        );
      const prepared = await run(process.execPath, [
        "scripts/run-exclusive.mjs",
        "artifacts",
        process.execPath,
        resolve("node_modules/turbo/bin/turbo"),
        "run",
        ...(plan.needsBuild ? ["artifacts:skills"] : []),
        ...plan.artifactTasks,
      ]);
      if (prepared.code !== 0) process.exitCode = prepared.code;
    }
    if (!process.exitCode && !shutdownSignal) {
      const tested = await run(process.execPath, [
        resolve("node_modules/vitest/vitest.mjs"),
        ...plan.vitestArguments,
      ]);
      process.exitCode = tested.code;
    }
  }
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
}
if (shutdownSignal) process.exitCode = signalExitCodes[shutdownSignal];

function run(executable, arguments_, capture = false) {
  if (shutdownSignal)
    return Promise.resolve({
      code: signalExitCodes[shutdownSignal],
      output: "",
    });
  child = spawn(executable, arguments_, {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  let output = "";
  if (capture) {
    child.stdout.on("data", (data) => (output += data.toString()));
    child.stderr.on("data", (data) => (output += data.toString()));
  }
  return new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(forceTimer);
      resolveResult({ code: code ?? 1, output });
    });
  });
}
