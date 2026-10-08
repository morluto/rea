import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  artifactCli,
  artifactMcpResult,
  withArtifactMcp,
} from "./lib/artifact-e2e.mjs";

const exec = promisify(execFile);

if (process.platform !== "darwin")
  throw new Error(
    "Native call observation verification requires macOS with Command Line Tools",
  );
for (const tool of ["clang", "lldb", "codesign", "nm"])
  try {
    await exec("/usr/bin/xcrun", ["--find", tool]);
  } catch (cause) {
    throw new Error(
      `Native call observation verification requires ${tool} from Command Line Tools (xcrun --find ${tool} failed)`,
      { cause },
    );
  }

const SOURCE = fileURLToPath(
  new URL("../tests/conformance/native/calls.m", import.meta.url),
);
const GREET = "-[ReaCallGreeter greet:times:]";
const INPUT = {
  breakpoints: [
    {
      kind: "objc-method",
      class_name: "ReaCallGreeter",
      selector: "greet:times:",
      method_type: "instance",
    },
    { kind: "function", name: "rea_call_add" },
  ],
  environment: { REA_CALLS_MARKER: "observed" },
  argument_registers: 4,
  backtrace_frames: 1,
};

/** Pointer-free facts that two runs of the same scenario must share. */
const stable = (result) =>
  result.events.map((event) => ({
    symbol: event.symbol,
    file_address: event.file_address,
    selector: event.selector,
    receiver_class: event.receiver_class,
    counter:
      event.symbol === GREET
        ? event.registers[3].value
        : event.registers[0].value,
  }));

const symbolAddress = async (binary, symbol) => {
  const { stdout } = await exec("/usr/bin/xcrun", ["nm", "-n", binary]);
  const line = stdout.split("\n").find((entry) => entry.endsWith(` ${symbol}`));
  assert.ok(line, `nm lists ${symbol}`);
  return `0x${BigInt(`0x${line.split(" ")[0]}`).toString(16)}`;
};

const checkScenario = async (binary) => {
  const result = await artifactCli("observe-native-calls", binary, [
    JSON.stringify(INPUT),
  ]);
  assert.equal(result.process.outcome, "exited");
  assert.equal(result.process.exit_status, 0);
  assert.equal(result.process.terminated, true);
  assert.match(result.process.stdout.text, /^world x0 40\n/u);
  assert.match(result.process.stdout.text, /marker observed\n$/u);
  assert.deepEqual(result.coverage, {
    status: "complete",
    event_limit_reached: false,
    unresolved_breakpoints: [],
  });
  const greet = result.events.filter(({ symbol }) => symbol === GREET);
  const add = result.events.filter(({ symbol }) => symbol === "rea_call_add");
  assert.equal(greet.length, 3);
  assert.equal(add.length, 3);
  for (const [index, event] of greet.entries()) {
    assert.equal(event.receiver_class, "ReaCallGreeter");
    assert.equal(event.selector, "greet:times:");
    assert.equal(event.registers[3].value, `0x${index}`);
    assert.equal(event.backtrace[0].symbol, "main");
    assert.equal(event.module, basename(binary));
  }
  for (const [index, event] of add.entries()) {
    assert.equal(event.registers[0].value, `0x${index}`);
    assert.equal(event.registers[1].value, "0x28");
  }
  // Breakpoints stop at the symbol itself, which Apple's nm reports.
  assert.equal(
    add[0].file_address,
    await symbolAddress(binary, "_rea_call_add"),
  );
  assert.equal(greet[0].file_address, await symbolAddress(binary, GREET));
  return result;
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const checkBounds = async (binary) => {
  const limited = await artifactCli("observe-native-calls", binary, [
    JSON.stringify({
      breakpoints: [{ kind: "function", name: "nanosleep" }],
      arguments: ["--wait"],
      max_events: 2,
      duration_ms: 30_000,
    }),
  ]);
  assert.equal(limited.process.outcome, "event-limit");
  assert.equal(limited.events.length, 2);
  assert.equal(limited.process.terminated, true);
  assert.equal(alive(limited.process.pid), false);
  const elapsed = await artifactCli("observe-native-calls", binary, [
    JSON.stringify({
      breakpoints: [{ kind: "function", name: "rea_call_add" }],
      arguments: ["--wait"],
      duration_ms: 1_500,
    }),
  ]);
  assert.equal(elapsed.process.outcome, "duration-elapsed");
  assert.equal(elapsed.events.length, 0);
  assert.equal(alive(elapsed.process.pid), false);
};

const cliFailure = async (binary) => {
  try {
    await exec(
      process.execPath,
      [
        fileURLToPath(new URL("rea.mjs", import.meta.url)),
        "observe-native-calls",
        binary,
        JSON.stringify(INPUT),
        "--json",
      ],
      { env: { ...process.env, REA_LOG_LEVEL: "silent" }, timeout: 120_000 },
    );
  } catch (cause) {
    return JSON.parse(cause.stdout);
  }
  throw new Error("observe-native-calls unexpectedly succeeded");
};

/** Hardened runtime blocks the debugger unless get-task-allow is granted. */
const checkHardenedRuntime = async (directory, binary) => {
  const blocked = join(directory, "hardened");
  await exec("/bin/cp", [binary, blocked]);
  await exec("/usr/bin/xcrun", [
    "codesign",
    "-f",
    "-s",
    "-",
    "-o",
    "runtime",
    blocked,
  ]);
  const denied = await cliFailure(blocked);
  assert.equal(denied.code, "capability_unavailable");
  assert.match(denied.details.reason, /^debugger-attach-denied: /u);
  const allowed = join(directory, "debuggable");
  const entitlements = join(directory, "get-task-allow.plist");
  await writeFile(
    entitlements,
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.get-task-allow</key><true/></dict></plist>',
  );
  await exec("/bin/cp", [binary, allowed]);
  await exec("/usr/bin/xcrun", [
    "codesign",
    "-f",
    "-s",
    "-",
    "-o",
    "runtime",
    "--entitlements",
    entitlements,
    allowed,
  ]);
  const traced = await checkScenario(allowed);
  assert.equal(traced.process.exit_status, 0);
};

const directory = await mkdtemp(join(tmpdir(), "rea-native-calls-"));
try {
  const binary = join(directory, "ReaCalls");
  await exec("/usr/bin/xcrun", [
    "clang",
    "-fobjc-arc",
    "-framework",
    "Foundation",
    SOURCE,
    "-o",
    binary,
  ]);
  const viaCli = await checkScenario(binary);
  await withArtifactMcp(binary, async (client) => {
    const viaMcp = await artifactMcpResult(
      client,
      "observe_native_calls",
      INPUT,
    );
    assert.deepEqual(stable(viaMcp), stable(viaCli));
    assert.equal(viaMcp.process.stdout.text, viaCli.process.stdout.text);
  });
  await checkBounds(binary);
  await checkHardenedRuntime(directory, binary);
  console.log(
    JSON.stringify({
      ok: true,
      mocked: false,
      cli: true,
      stdio_mcp: true,
      debugger: viaCli.debugger.version,
      events: viaCli.events.length,
      outcomes: ["exited", "event-limit", "duration-elapsed"],
      hardened_runtime: {
        without_get_task_allow: "denied",
        with_get_task_allow: "traced",
      },
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
