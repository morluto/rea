import { Readable, Writable } from "node:stream";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareCliProcessEnvironment } from "../../../scripts/lib/cli-process-environment.mjs";
import { withVerifierCleanup } from "../../../scripts/lib/verifier-cleanup.mjs";
import {
  createCliSessionFrameReader,
  encodeCliSessionFrame,
} from "./cliCommandSessionFrames.mjs";

// Commands run through the same one-shot owner as scripts/rea.mjs. Output is
// captured per command so this process can serve the next invocation.
const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const { default: packageJson } = await import(
  new URL("../../../package.json", import.meta.url),
  { with: { type: "json" } }
);

// Present the launcher's entrypoint, as a fresh `rea` process does. The
// runtime derives the current registration command from it at load time.
process.argv[1] = resolve(packageRoot, "scripts/rea.mjs");

const runtimeFiles = [
  "dist/cli-runtime/cli.js",
  "dist/cli-runtime/cliOneShot.js",
];

prepareCliProcessEnvironment(
  process.env,
  process.platform,
  packageJson.version,
);
if (!(await compiledRuntimeExists(runtimeFiles))) {
  process.stderr.write(
    `REA's compiled runtime is missing. Run \`npm ci && npm run build:cached\` in ${packageRoot} to install dependencies and build REA, then restart it. If this is an installed package, reinstall rea-agents.\n`,
  );
  process.exit(1);
}

const { closeCliResources } = await import("../../../dist/cli-runtime/cli.js");
const { runOneShotCli } =
  await import("../../../dist/cli-runtime/cliOneShot.js");

const writeFrame = (value) =>
  new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(encodeCliSessionFrame(value), (error) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });

await writeFrame({ ready: true });

let chain = Promise.resolve();
// EOF drains admitted commands; failure seals input and skips commands not yet started.
/** @type {{ kind: "open" } | { kind: "ended" } | { kind: "failed", cause: unknown }} */
let completion = { kind: "open" };
/** @type {(() => void) | undefined} */
let resolveInput;
/** @type {Promise<void>} */
const inputStopped = new Promise((resolve) => {
  resolveInput = resolve;
});
const failInput = (cause) => {
  if (completion.kind !== "failed") completion = { kind: "failed", cause };
  process.stdin.pause();
  resolveInput?.();
};
process.stdin.once("end", () => {
  if (completion.kind === "open") completion = { kind: "ended" };
  resolveInput?.();
});
const reader = createCliSessionFrameReader((value) => {
  if (completion.kind !== "open") return;
  chain = chain
    .then(async () => {
      if (completion.kind !== "failed") await handle(value);
    })
    .catch(failInput);
});
process.stdin.on("data", (chunk) => {
  if (completion.kind !== "open") return;
  try {
    reader(chunk);
  } catch (cause) {
    failInput(cause);
  }
});
try {
  await withVerifierCleanup(async () => {
    await inputStopped;
    await chain;
    if (completion.kind === "failed") throw completion.cause;
  }, [closeCliResources]);
} catch (cause) {
  console.error(cause);
  process.exit(1);
}
process.exit(0);

async function handle(value) {
  const request = value;
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  try {
    if (
      request === null ||
      typeof request !== "object" ||
      !Array.isArray(request.arguments) ||
      typeof request.cwd !== "string" ||
      request.env === null ||
      typeof request.env !== "object"
    ) {
      throw new Error(
        "CLI session command is missing its arguments, cwd, or environment",
      );
    }
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, request.env);
    prepareCliProcessEnvironment(
      process.env,
      process.platform,
      packageJson.version,
    );
    process.chdir(request.cwd);
    const result = await runOneShot(request.arguments);
    await writeFrame({
      id: request.id,
      pid: process.pid,
      rss: process.memoryUsage().rss,
      ...result,
    });
  } catch (error) {
    failInput(error);
    const id =
      request !== null && typeof request === "object" ? request.id : undefined;
    await writeFrame({
      id,
      pid: process.pid,
      exitCode: 1,
      stdout: "",
      stderr:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      fatal: true,
    });
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    process.chdir(savedCwd);
  }
}

async function runOneShot(args) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = captureWrite(stdoutChunks);
  process.stderr.write = captureWrite(stderrChunks);
  // This process's stdin carries session frames. Give each command the empty,
  // ended stdin a fresh process receives when the caller supplies no input.
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  const commandStdin = Readable.from([]);
  Object.defineProperty(process, "stdin", {
    configurable: true,
    enumerable: stdinDescriptor?.enumerable ?? true,
    get: () => commandStdin,
  });
  const destination = new Writable({
    write(chunk, encoding, callback) {
      process.stdout.write(chunk, encoding, callback);
    },
  });
  destination.isTTY = process.stdout.isTTY === true;
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  let explicitExit;
  let exitOutput;
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
      stdoutIsTerminal: destination.isTTY,
      resultDestination: destination,
      // The session frames own this process's stdout; a command's reader
      // cannot close it.
      closedStdoutStatus: 1,
      writeStdout: (text) => {
        process.stdout.write(text);
      },
      writeStderr: (text) => {
        process.stderr.write(text);
      },
      stdoutClosed: () => false,
      exitCode: () =>
        typeof process.exitCode === "number" ? process.exitCode : 0,
      setExitCode: (code) => {
        process.exitCode = code;
      },
      // The session closes CLI resources once, after its last command.
      ownCliResources: () => {},
      exitRequested: () => exitOutput !== undefined,
      // This process serves the next command; record the status and finish
      // the pending result in place of exiting.
      exit: (code, finishOutput) => {
        explicitExit = code;
        exitOutput = finishOutput(code);
      },
    });
    await exitOutput;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (stdinDescriptor !== undefined)
      Object.defineProperty(process, "stdin", stdinDescriptor);
  }
  const exitCode =
    explicitExit ??
    (typeof process.exitCode === "number" ? process.exitCode : 0);
  process.exitCode = previousExitCode;
  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

function captureWrite(chunks) {
  return function patched(chunk, encoding, callback) {
    const encodingName = typeof encoding === "string" ? encoding : "utf8";
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encodingName),
    );
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") done();
    return true;
  };
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
