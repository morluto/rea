import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackageVerifierCommands } from "./lib/verify-package-commands.mjs";

import {
  artifactCli,
  artifactMcpResult,
  withArtifactMcp,
} from "./lib/artifact-e2e.mjs";
import { createCanonicalTemporaryDirectory } from "./lib/canonical-temporary-directory.mjs";

const cancellation = new AbortController();
let shutdownSignal;
const signalExitCodes = { SIGINT: 130, SIGTERM: 143 };
const forwardCancellation = (signal) => {
  if (shutdownSignal !== undefined) return;
  shutdownSignal = signal;
  cancellation.abort(new Error(`Verification cancelled by ${signal}`));
};
const signalHandlers = Object.fromEntries(
  Object.keys(signalExitCodes).map((signal) => [
    signal,
    () => forwardCancellation(signal),
  ]),
);
for (const [signal, handler] of Object.entries(signalHandlers))
  process.on(signal, handler);

const compiler = process.env.REA_VERIFY_FPC_COMMAND;
if (process.platform !== "darwin" || !isAbsolute(compiler ?? ""))
  throw new Error(
    "Requires macOS and an absolute caller-selected REA_VERIFY_FPC_COMMAND; build the runtime first.",
  );
const source = fileURLToPath(
  new URL("../tests/conformance/native/calls.pas", import.meta.url),
);
const fixtureLines = (await readFile(source, "utf8")).split(/\r?\n/u);
const callerLines = new Set(
  ["REA_VERIFY_CALLER_LOOP", "REA_VERIFY_CALLER_CALL"].map((marker) => {
    const matches = fixtureLines.flatMap((line, index) =>
      line.includes(marker) ? [index + 1] : [],
    );
    assert.equal(matches.length, 1, `fixture has one ${marker} marker`);
    return matches[0];
  }),
);
const allocatedDirectory =
  await createCanonicalTemporaryDirectory("rea-pascal-calls-");
let directory = allocatedDirectory.path;
const commands = await createPackageVerifierCommands({
  workspace: {
    path: allocatedDirectory.allocatedPath,
    close: () =>
      rm(allocatedDirectory.allocatedPath, { recursive: true, force: true }),
  },
});
const execute = (command, arguments_, { timeout }) =>
  commands.exec(command, arguments_, {
    timeout,
    diagnosticBytes: 1024 * 1024,
    signal: cancellation.signal,
  });
const input = {
  breakpoints: [{ kind: "function", name: "rea_pascal_call" }],
  argument_registers: 1,
  backtrace_frames: 1,
  duration_ms: 30_000,
};
const inspect = (result) => {
  assert.equal(result.process.outcome, "exited");
  assert.equal(result.process.exit_status, 0);
  assert.equal(result.process.terminated, true);
  assert.equal(result.process.stdout.text, "pascal 0\npascal 1\npascal 2\n");
  assert.equal(result.events.length, 3);
  assert.deepEqual(
    result.events.map((event) => event.registers[0].value),
    ["0x0", "0x1", "0x2"],
  );
  assert.equal(result.breakpoints[0].location_count, 1);
  for (const event of result.events) {
    assert.equal(event.backtrace.length, 1);
    assert.equal(event.backtrace[0].source_location?.file_path, source);
    assert.equal(event.backtrace[0].module_path, join(directory, "calls"));
    assert.ok(
      callerLines.has(event.backtrace[0].source_location.line),
      "caller is the Pascal loop/call site",
    );
  }
  for (const location of [
    ...result.events,
    ...result.breakpoints[0].locations,
  ]) {
    assert.equal(location.source_location?.file_path, source);
    assert.ok(location.source_location.line > 0);
  }
};
const stable = (result) =>
  result.events.map((event) => ({
    file_address: event.file_address,
    source_location: event.source_location,
    registers: event.registers,
    callers: event.backtrace.map((frame) => ({
      file_address: frame.file_address,
      symbol: frame.symbol,
      source_location: frame.source_location,
    })),
  }));
try {
  const version = (
    await execute(compiler, ["-iV"], { timeout: 30_000 })
  ).stdout.trim();
  const architecture = (
    await execute(compiler, ["-iTP"], {
      timeout: 30_000,
    })
  ).stdout.trim();
  await execute(
    compiler,
    [
      "-dDEBUG",
      "-gw3",
      "-O-",
      "-Xs-",
      `-FE${directory}`,
      `-FU${directory}`,
      source,
    ],
    { timeout: 120_000 },
  );
  const binary = join(directory, "calls");
  const cli = await artifactCli(
    "observe-native-calls",
    binary,
    [JSON.stringify(input)],
    { timeoutMs: 180_000 },
  );
  inspect(cli);
  await withArtifactMcp(binary, async (client) => {
    const mcp = await artifactMcpResult(client, "observe_native_calls", input);
    inspect(mcp);
    assert.deepEqual(stable(mcp), stable(cli));
  });
  console.log(
    JSON.stringify({
      ok: true,
      mocked: false,
      compiler,
      version,
      architecture,
      debugger: cli.debugger,
      cli: true,
      stdio_mcp: true,
      scope:
        "bounded native call entries and compiler-provided source coordinates; no typed Pascal locals or interactive stepping",
    }),
  );
} catch (cause) {
  if (shutdownSignal === undefined) throw cause;
  console.error(`Verification cancelled by ${shutdownSignal}.`);
  process.exitCode = signalExitCodes[shutdownSignal];
} finally {
  try {
    await commands.close();
  } finally {
    for (const signal of Object.keys(signalExitCodes))
      process.off(signal, signalHandlers[signal]);
  }
}
