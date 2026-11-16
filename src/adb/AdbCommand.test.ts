import { afterAll, beforeAll, expect, it } from "vitest";
import { probeAdbPathExistence, runAdbCapture } from "./AdbCommand.js";
import type { AdbCommandHost } from "./AdbProcess.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { spawnOwnedProviderProcess } from "../process/ProviderProcess.js";
import { prepareProcessOwnershipInspection } from "../process/ProcessOwnershipObservation.js";
import { ArtifactResourceScope } from "../resources/index.js";
import { spawnFailure } from "../../tests/support/process/spawnFailure.js";

const resources = new ArtifactResourceScope();
beforeAll(() => prepareProcessOwnershipInspection());
afterAll(() => resources.close());

const selection = {
  binary: "/host/adb",
  pathSource: "environment",
  environment: {},
  resources,
} as const;

/** A real owned process standing in for adb, running `script` under Node. */
const scripted = (
  script: string,
  observe?: (stream: "stdout" | "stderr", text: string) => void,
): AdbCommandHost => ({
  ...selection,
  launcher: async (input) => {
    const launched = await spawnOwnedProviderProcess({
      ...input,
      command: process.execPath,
      arguments: ["-e", script],
    });
    if (observe !== undefined)
      for (const stream of ["stdout", "stderr"] as const)
        launched.process[stream]?.on("data", (chunk: Buffer) =>
          observe(stream, chunk.toString("utf8")),
        );
    return launched;
  },
});

/** adb exits on its own with this output and status. */
const exits = (
  code: number,
  output: { readonly stdout?: string; readonly stderr?: string } = {},
): AdbCommandHost =>
  scripted(
    `process.stdout.write(${JSON.stringify(output.stdout ?? "")});` +
      `process.stderr.write(${JSON.stringify(output.stderr ?? "")});` +
      `process.exitCode = ${String(code)};`,
  );

/** The host refuses to start adb with this launcher error. */
const refused = (failure: unknown): AdbCommandHost => ({
  ...selection,
  launcher: async () => {
    throw failure;
  },
});

const probe = (host: AdbCommandHost, signal?: AbortSignal) =>
  probeAdbPathExistence(
    "push_adb_file",
    "device",
    "/device/path",
    host,
    {
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
    },
    signal,
  );

it("classifies the complete diagnostic before shortening its displayed reason", async () => {
  const localPath = `/host/${"directory/".repeat(60)}payload.bin`;
  const stderr = `adb: error: cannot create '${localPath}': Permission denied`;
  await expect(
    runAdbCapture(
      "pull_adb_file",
      { device: "device", path: "/remote/file", localPath },
      exits(1, { stderr }),
      [],
      { timeoutMs: 10_000, maxOutputBytes: 2048 },
      undefined,
    ),
  ).resolves.toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisUnsupportedTargetError",
      path: localPath,
      reason: `${stderr.slice(0, 512)}…`,
    },
  });
});

it("recognizes only the completed empty false result as absence", async () => {
  await expect(probe(exits(1))).resolves.toEqual({
    ok: true,
    value: {
      matches: false,
      capturedOutput: {
        exit_code: 1,
        stdout: "",
        stderr: "",
        stdout_bytes: 0,
        stderr_bytes: 0,
        signal: null,
        truncated: false,
      },
    },
  });
});

it.each([
  ["exit status 2", exits(2)],
  ["a refused launch", refused(spawnFailure("ENOENT", "/host/adb"))],
  [
    "a signal exit",
    scripted(
      "process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000)",
    ),
  ],
  ["unexpected stdout", exits(1, { stdout: "unexpected" })],
  ["unrecognized stderr", exits(1, { stderr: " " })],
] as const)(
  "keeps nonstandard false completion unknown: %s",
  async (_case, host) => {
    expect(await probe(host)).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisProtocolError" },
    });
  },
);

it("keeps a nonstandard false completion's destination status unknown", async () => {
  expect(await probe(exits(2))).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisProtocolError",
      diagnostics: { destination_existence: "unknown" },
      capturedOutput: { exit_code: 2 },
    },
  });
});

it("preserves a probe stopped at its deadline", async () => {
  const result = await probeAdbPathExistence(
    "push_adb_file",
    "device",
    "/device/path",
    scripted("setInterval(() => {}, 1000)"),
    { timeoutMs: 100, maxOutputBytes: 1024 },
    undefined,
  );
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisTimeoutError" },
  });
});

it.each([
  [true, "live", true],
  [undefined, "capture", false],
] as const)(
  "stops output beyond the capture allowance and names its byte value (volatile output: %s)",
  async (volatileOutput, kind, retryable) => {
    const result = await runAdbCapture(
      "list_adb_devices",
      { device: "device" },
      scripted(
        "process.stdout.write('x'.repeat(64 * 1024)); setInterval(() => {}, 1000)",
      ),
      ["devices"],
      {
        timeoutMs: 10_000,
        maxOutputBytes: 1024,
        ...(volatileOutput === undefined ? {} : { volatileOutput }),
      },
      undefined,
    );
    if (result.ok) throw new Error("Expected a capture refusal");
    expect(result.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      retryable,
      capturedOutput: { stdout: "x".repeat(1024), truncated: true },
    });
    expect(result.error).toHaveProperty("fixedAllowance", {
      name: expect.any(String),
      kind,
      limit: 1024,
      unit: "bytes",
    });
  },
);

it("recognizes an empty successful probe as existence", async () => {
  await expect(probe(exits(0))).resolves.toEqual({
    ok: true,
    value: {
      matches: true,
      capturedOutput: {
        exit_code: 0,
        stdout: "",
        stderr: "",
        stdout_bytes: 0,
        stderr_bytes: 0,
        signal: null,
        truncated: false,
      },
    },
  });
});

it.each(["stdout", "stderr"] as const)(
  "retains unexpected successful %s as unknown",
  async (stream) => {
    await expect(
      probe(exits(0, { [stream]: "unexpected" })),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisProtocolError",
        capturedOutput: { [stream]: "unexpected", exit_code: 0 },
      },
    });
  },
);

it("hands back stdout bytes that are not UTF-8 exactly", async () => {
  const result = await runAdbCapture(
    "capture_adb_screen",
    { device: "device" },
    scripted("process.stdout.write(Buffer.from([0x89, 0xff, 0x00]))"),
    ["exec-out", "screencap", "-p"],
    { timeoutMs: 10_000, maxOutputBytes: 3 },
    undefined,
  );
  if (!result.ok) throw result.error;
  expect([...result.value.stdout]).toEqual([0x89, 0xff, 0x00]);
});

it.each([null, "caller stopped", new Error("caller stopped")] as const)(
  "uses the command owner's exact %s cancellation reason",
  async (reason) => {
    const controller = new AbortController();
    const seen = { stdout: "", stderr: "" };
    const result = await probe(
      scripted(
        "process.stdout.write('partial'); process.stderr.write('diagnostic'); setInterval(() => {}, 1000)",
        (stream, text) => {
          seen[stream] += text;
          if (seen.stdout === "partial" && seen.stderr === "diagnostic")
            controller.abort(reason);
        },
      ),
      controller.signal,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    if (result.ok) throw new Error("Expected owned cancellation");
    expect(result.error.cause).toBe(reason);
    expect(result.error.capturedOutput).toMatchObject({
      stderr: "diagnostic",
      stderr_bytes: 10,
    });
  },
);

it("keeps a physical failure even when the later abort reason is that same error", async () => {
  const controller = new AbortController();
  const failure = new Error("physical command failure");
  const result = await runAdbCapture(
    "inspect_adb_device",
    { device: "device" },
    {
      ...selection,
      launcher: async () => {
        controller.abort(failure);
        throw failure;
      },
    },
    [],
    { timeoutMs: 10_000, maxOutputBytes: 1024 },
    controller.signal,
  );
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisProtocolError", cause: failure },
  });
});

const STARTUP_NOTICES = [
  "* daemon not running; starting now at tcp:5037\n* daemon started successfully\n",
  "* daemon not running. starting it now on port 5037 *\r\n* daemon started successfully *\r\n",
];
it.each(STARTUP_NOTICES)(
  "recognizes completed true and false probes with successful startup: %j",
  async (stderr) => {
    await expect(probe(exits(0, { stderr }))).resolves.toMatchObject({
      ok: true,
      value: {
        matches: true,
        capturedOutput: {
          stdout: "",
          stderr,
          exit_code: 0,
          stderr_bytes: Buffer.byteLength(stderr),
        },
      },
    });
    await expect(probe(exits(1, { stderr }))).resolves.toMatchObject({
      ok: true,
      value: {
        matches: false,
        capturedOutput: {
          stdout: "",
          stderr,
          exit_code: 1,
          stderr_bytes: Buffer.byteLength(stderr),
        },
      },
    });
  },
);

it.each([
  "* daemon not running; starting now at tcp:5037\n",
  "* daemon failed to start\n",
  "* daemon started successfully\n* daemon not running; starting now at tcp:5037\n",
  "* daemon started successfully\nunexpected\n",
  "\n",
  " ",
])("refuses an incomplete or unknown startup output: %j", async (stderr) => {
  await expect(probe(exits(0, { stderr }))).resolves.toMatchObject({
    ok: false,
    error: { capturedOutput: { stderr, exit_code: 0 } },
  });
  await expect(probe(exits(1, { stderr }))).resolves.toMatchObject({
    ok: false,
    error: { capturedOutput: { stderr, exit_code: 1 } },
  });
});

it("reports an adb that never started without claiming an exit code", async () => {
  const result = await runAdbCapture(
    "list_adb_devices",
    { device: "device" },
    refused(spawnFailure("ENOTDIR", "/host/adb")),
    ["devices"],
    { timeoutMs: 10_000, maxOutputBytes: 1024 },
    undefined,
  );
  if (result.ok) throw new Error("Expected a launch failure");
  expect(result.error).toMatchObject({
    _tag: "AnalysisProtocolError",
    message: "adb could not be started (ENOTDIR) for list_adb_devices",
  });
  expect(result.error.capturedOutput).toBeUndefined();
});

it.each([
  ["EAGAIN", "capacity", true, { boundary: "host-capacity" }],
  // Device commands carry request operands, so the request may shrink too.
  [
    "E2BIG",
    "transport",
    false,
    {
      boundary: "provider-launch",
      oversized_launch_input: "request_and_environment",
    },
  ],
] as const)(
  "reports host launch constraint %s through the shared launch owner rather than as an adb protocol failure",
  async (code, resource, retryable, facts) => {
    const result = await runAdbCapture(
      "list_adb_devices",
      { device: "device" },
      refused(spawnFailure(code, "/host/adb")),
      ["devices"],
      { timeoutMs: 10_000, maxOutputBytes: 1024 },
      undefined,
    );
    if (result.ok) throw new Error("Expected a launch constraint");
    expect(result.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      resource,
      retryable,
      reportedLimits: { spawn_error: code },
    });
    expect(projectAnalysisError(result.error)).toMatchObject({
      details: {
        diagnostics: { system_code: code, command: "/host/adb", ...facts },
      },
    });
  },
);
