#!/usr/bin/env node

import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareCliProcessEnvironment } from "./lib/cli-process-environment.mjs";
import { unsupportedRuntimeMessage } from "./lib/runtime-admission.mjs";

// Route production MCP before importing Incur. Incur owns registration helpers
// such as `mcp add`, while the MCP runtime serves the tool catalog over stdio
// or, with `--http`, over streamable HTTP.
const args = process.argv.slice(2);
const { default: packageJson } = await import("../package.json", {
  with: { type: "json" },
});
// Admit the runtime before the first compiled import. Compiled modules import
// Node APIs that absent releases only reject while linking, so an unsupported
// release previously surfaced as a module error from every command, including
// `--version` and `doctor`. `process.exit` is required here: setting exitCode
// would still reach the imports below.
const unsupportedRuntime = unsupportedRuntimeMessage(
  packageJson.engines?.node,
  process.versions.node,
);
if (unsupportedRuntime !== undefined) {
  process.stderr.write(`${unsupportedRuntime}\n`);
  process.exit(1);
}
prepareCliProcessEnvironment(
  process.env,
  process.platform,
  packageJson.version,
);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builtinArgumentRuntime = "dist/cli-runtime/cliBuiltinArguments.js";
const builtinArguments = (await compiledRuntimeExists([builtinArgumentRuntime]))
  ? await import("../dist/cli-runtime/cliBuiltinArguments.js")
  : undefined;
const isShellCompletion =
  builtinArguments?.cliCompletionShell?.(process.env) !== undefined;
const doctorArguments = isShellCompletion
  ? undefined
  : builtinArguments?.productionMcpDoctorArguments(args);
const isMcpEntry =
  !isShellCompletion && (args[0] === "--mcp" || args[0] === "mcp");
const isMcpMode = isMcpEntry && args.length === 1;
const isMcpDoctorMode = doctorArguments !== undefined;
// Only flags may follow the entry: `mcp add --http` stays Incur's `mcp add`,
// while `mcp -h --http` reaches the HTTP entry's own help.
const isMcpHttpMode =
  isMcpEntry &&
  (args[1]?.startsWith("-") ?? false) &&
  args.slice(1).includes("--http");
/** How long an exiting command may wait for its remaining handles to close. */
const EXIT_DRAIN_GRACE_MS = 1_000;
/** Exit status of a writer terminated by SIGPIPE (128 + 13). */
const SIGPIPE_EXIT_STATUS = 141;
// Set once the reader of CLI output has closed the pipe.
let stdoutClosed = false;
const runtimeFiles = [
  builtinArgumentRuntime,
  ...(isMcpMode || isMcpHttpMode
    ? ["dist/mcp/main.js"]
    : isMcpDoctorMode
      ? ["dist/mcp/main.js", "dist/cli-runtime/mcpDoctor.js"]
      : [
          "dist/cli-runtime/cli.js",
          "dist/cli-runtime/cliOneShot.js",
          "dist/cli-runtime/cliResultOutput.js",
        ]),
];

if (!(await compiledRuntimeExists(runtimeFiles))) {
  process.stderr.write(
    `REA's compiled runtime is missing. Run \`npm ci && npm run build:cached\` in ${packageRoot} to install dependencies and build REA, then restart it. If this is an installed package, reinstall rea-agents.\n`,
  );
  process.exitCode = 1;
} else if (isMcpMode) {
  const { runEntrypoint } = await import("../dist/mcp/main.js");
  await runEntrypoint();
} else if (isMcpHttpMode) {
  const { runMcpHttpEntrypoint } = await import("../dist/mcp/main.js");
  await runMcpHttpEntrypoint(args.slice(1));
} else if (isMcpDoctorMode) {
  guardClosedStdout();
  // Doctor runs outside Incur, so handle its global timing flag here. Keep a
  // token consumed by --format as a value, even when it looks like a flag.
  const { arguments: doctorCliArguments, enabled: timingRequested } =
    builtinArguments.splitCliTimingArguments(doctorArguments);
  const started = performance.now();
  try {
    const { runProductionMcpDoctorCli } =
      await import("../dist/cli-runtime/mcpDoctor.js");
    const result = await runProductionMcpDoctorCli(doctorCliArguments, {
      dispatcherPath: fileURLToPath(import.meta.url),
      packageRoot,
      stdoutIsTerminal: process.stdout.isTTY === true,
    });
    writeStdout(result.output);
    process.exitCode = result.exitCode;
  } finally {
    if (timingRequested)
      process.stderr.write(
        `${JSON.stringify({ rea_timings: { version: 1, command_ms: Math.round(performance.now() - started) } })}\n`,
      );
  }
} else {
  const { runOneShotCli } = await import("../dist/cli-runtime/cliOneShot.js");
  guardClosedStdout();
  let dispatchFailure;
  let closeCliResources;
  // Incur can exit from the callback below before this function returns.
  // That callback owns the status, including a closed-pipe exit of 141.
  let exiting = false;
  try {
    await runOneShotCli(args, {
      environment: process.env,
      runtime: {
        packageName: packageJson.name,
        packageVersion: packageJson.version,
        versions: process.versions,
        platform: process.platform,
        architecture: process.arch,
      },
      stdoutIsTerminal: process.stdout.isTTY === true,
      resultDestination: process.stdout,
      closedStdoutStatus: SIGPIPE_EXIT_STATUS,
      writeStdout,
      writeStderr: (text) => {
        process.stderr.write(text);
      },
      stdoutClosed: () => stdoutClosed,
      exitCode: () =>
        typeof process.exitCode === "number" ? process.exitCode : 0,
      setExitCode: (code) => {
        process.exitCode = code;
      },
      ownCliResources: (close) => {
        closeCliResources = close;
      },
      exitRequested: () => exiting,
      // A command failure caused by the closed pipe keeps the pipe's status.
      // Worker shutdown is shared with the dispatch finally below. A failed
      // shutdown is reported here because this callback is what exits.
      exit: (code, finishOutput) => {
        exiting = true;
        void (async () => {
          let status = code;
          try {
            await closeCliResources();
          } catch (cleanup) {
            process.stderr.write(
              `Failed to close CLI resources: ${cleanupFailureText(cleanup)}\n`,
            );
            if (status === 0) status = 1;
          }
          try {
            await finishOutput(status);
          } catch (cause) {
            if (!stdoutClosed)
              process.stderr.write(`${cleanupFailureText(cause)}\n`);
            if (status === 0) status = 1;
          }
          // process.exit() shuts the platform down without tearing the
          // isolate down, so a V8 compile thread waiting for a collection can
          // deadlock that shutdown. Let the event loop drain instead, and force
          // the exit only when a handle outlives a short grace.
          process.exitCode = stdoutClosed ? SIGPIPE_EXIT_STATUS : status;
          setTimeout(
            () => process.exit(process.exitCode),
            EXIT_DRAIN_GRACE_MS,
          ).unref();
        })();
      },
    });
  } catch (cause) {
    if (cause?.code === "EPIPE") {
      stdoutClosed = true;
      process.exitCode = SIGPIPE_EXIT_STATUS;
    }
    dispatchFailure = cause;
  } finally {
    // Serve and output rendering can throw after a worker is parked. Stop it
    // on that path too, and keep the dispatch failure when both fail.
    try {
      await closeCliResources?.();
    } catch (cleanup) {
      // The exit callback reports this same shared failure and then exits.
      if (!exiting) {
        dispatchFailure =
          dispatchFailure === undefined
            ? cleanup
            : new AggregateError(
                [dispatchFailure, cleanup],
                "CLI dispatch failed and the JavaScript analysis worker remained owned",
              );
      }
    }
  }
  if (
    !exiting &&
    dispatchFailure !== undefined &&
    !(stdoutClosed && dispatchFailure?.code === "EPIPE")
  )
    throw dispatchFailure;
}

/**
 * A reader that closes the pipe early, as `rea ... | head` does, has declined
 * the rest of the output. Stop writing without reporting a failure, and exit
 * with the status a SIGPIPE-terminated writer reports. MCP stdio keeps its own
 * client lifecycle.
 */
function cleanupFailureText(cleanup) {
  if (cleanup instanceof Error) return cleanup.stack ?? cleanup.message;
  return String(cleanup);
}

function guardClosedStdout() {
  process.stdout.on("error", (cause) => {
    if (cause?.code === "EPIPE") {
      stdoutClosed = true;
      process.exitCode = SIGPIPE_EXIT_STATUS;
      return;
    }
    // Other failures stay unhandled unless a pending JSON write reports them.
    if (process.stdout.listenerCount("error") === 1) throw cause;
  });
}

function writeStdout(output) {
  if (!stdoutClosed) process.stdout.write(output);
}

async function compiledRuntimeExists(paths) {
  for (const path of paths) {
    try {
      await access(resolve(packageRoot, path));
    } catch (cause) {
      if (isMissing(cause)) return false;
      throw cause;
    }
  }
  return true;
}

function isMissing(cause) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}
