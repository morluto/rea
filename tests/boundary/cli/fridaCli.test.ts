import { expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import type { FridaInstrumentationPort } from "../../../src/application/frida/FridaInstrumentationPort.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { FridaInstrumentationManager } from "../../../src/frida/FridaInstrumentationManager.js";

it("maps one-shot Frida CLI target, script, duration, and remote options", async () => {
  const calls: unknown[] = [];
  const provider: FridaInstrumentationPort = {
    async listDevices() {
      calls.push({ operation: "devices" });
      return { ok: true, value: { devices: [], cleanupError: null } };
    },
    async listProcesses() {
      return {
        ok: true,
        value: { deviceId: "local", processes: [], cleanupError: null },
      };
    },
    async startSession(input) {
      calls.push({ operation: "start", input });
      return {
        ok: true,
        value: {
          sessionId: "00000000-0000-4000-8000-000000000001",
          deviceId: "remote",
          target: "fixture",
          pid: 71,
          mode: input.mode,
          state: "running",
        },
      };
    },
    async loadScript(sessionId, source) {
      calls.push({ operation: "load", sessionId, source });
      return {
        ok: true,
        value: {
          scriptId: "00000000-0000-4000-8000-000000000002",
          sourceKind: source.sourceKind,
          sourcePath: source.sourceKind === "file" ? source.path : null,
          sourceSha256: "a".repeat(64),
          messages: [{ type: "send", payload: "observed" }],
          messagesTruncated: false,
        },
      };
    },
    async resumeSession(sessionId) {
      calls.push({ operation: "resume", sessionId });
      return { ok: true, value: null };
    },
    async unloadScript() {
      return { ok: true, value: null };
    },
    status(sessionId) {
      return {
        sessionId,
        deviceId: "remote",
        target: "fixture",
        pid: 71,
        mode: "attach",
        state: "running",
        targetResumeObserved: false,
        scripts: [],
        messages: [],
        messagesTruncated: false,
      };
    },
    async closeSession(sessionId) {
      calls.push({ operation: "close", sessionId });
      return { ok: true, value: { targetResumeObserved: false } };
    },
    async closeAll() {},
  };
  const cli = createCli({}, undefined, provider);
  let stdout = "";
  let exitCode = 0;
  await cli.serve(
    [
      "instrument-with-frida",
      "attach",
      "71",
      "--script",
      "send('hello')",
      "--remote-address",
      "127.0.0.1:27042",
      "--token",
      "synthetic-secret-token",
      "--keepalive-interval",
      "10",
      "--duration-ms",
      "0",
      "--json",
    ],
    {
      env: {},
      exit: (code) => {
        exitCode = code;
      },
      stdout: (text) => {
        stdout += text;
      },
    },
  );
  expect(exitCode).toBe(0);
  const result: unknown = JSON.parse(stdout);
  expect(JSON.stringify(result)).not.toContain("synthetic-secret-token");
  expect(calls).toEqual([
    {
      operation: "start",
      input: {
        mode: "attach",
        pid: 71,
        remote: {
          address: "127.0.0.1:27042",
          token: "synthetic-secret-token",
          keepaliveInterval: 10,
        },
        source: { sourceKind: "inline", source: "send('hello')" },
        durationMs: 0,
      },
    },
    {
      operation: "load",
      sessionId: "00000000-0000-4000-8000-000000000001",
      source: { sourceKind: "inline", source: "send('hello')" },
    },
    {
      operation: "close",
      sessionId: "00000000-0000-4000-8000-000000000001",
    },
  ]);

  stdout = "";
  exitCode = 0;
  await cli.serve(
    ["list-frida-devices", "--token", "synthetic-secret-token", "--json"],
    {
      env: {},
      exit: (code) => {
        exitCode = code;
      },
      stdout: (text) => {
        stdout += text;
      },
    },
  );
  expect(exitCode).not.toBe(0);
  expect(calls).toHaveLength(3);
  expect(stdout).not.toContain("synthetic-secret-token");
});

it("awaits failed startup cleanup and retains the primary error if cleanup still fails", async () => {
  for (const cleanupFails of [false, true]) {
    const calls: string[] = [];
    const provider: FridaInstrumentationPort =
      new FridaInstrumentationManager();
    provider.startSession = async () => {
      calls.push("start");
      return {
        ok: false,
        error: new AnalysisCapabilityUnavailableError(
          "frida",
          "start_frida_session",
          "attach failed after spawn",
          {
            cleanup: {
              reason: "first resume failed",
              resources: ["paused spawn"],
            },
          },
        ),
      };
    };
    provider.closeAll = async () => {
      calls.push("cleanup");
      if (cleanupFails) throw new Error("resume still failed");
    };
    let stdout = "";
    await createCli({}, undefined, provider).serve(
      [
        "instrument-with-frida",
        "spawn",
        "/tmp/fixture",
        "--script",
        "send('ready')",
        "--json",
      ],
      {
        env: {},
        exit: () => {},
        stdout: (text) => {
          stdout += text;
        },
      },
    );
    expect(calls).toEqual(["start", "cleanup"]);
    const output: unknown = JSON.parse(stdout);
    expect(output).toMatchObject({
      code: cleanupFails ? "cleanup_incomplete" : "capability_unavailable",
    });
    expect(stdout).toContain("attach failed after spawn");
    if (cleanupFails) expect(stdout).toContain("primary_error");
  }
});

it("preserves observed devices when CLI provider cleanup fails", async () => {
  const provider: FridaInstrumentationPort = new FridaInstrumentationManager();
  const devices = [
    { deviceId: "remote-device", name: "selected endpoint", type: "remote" },
  ];
  provider.listDevices = async () => ({
    ok: true,
    value: { devices, cleanupError: null },
  });
  provider.closeAll = async () => {
    throw new Error("remote removal failed");
  };
  let stdout = "";
  await createCli({}, undefined, provider).serve(
    ["list-frida-devices", "--json"],
    {
      env: {},
      exit: () => {},
      stdout: (text) => {
        stdout += text;
      },
    },
  );
  const output: unknown = JSON.parse(stdout);
  expect(output).toMatchObject({
    code: "cleanup_incomplete",
    details: { diagnostics: { partial_observation: { devices } } },
  });
});

it.each([
  [
    ["attach", "abc", "--script", "send(1)"],
    "target",
    "attach mode needs a positive integer process ID.",
  ],
  [
    ["attach", "71"],
    "script",
    "Provide exactly one of --script or --script-file.",
  ],
])(
  "names the rejected instrument-with-frida argument for %j",
  async (argv, path, message) => {
    let starts = 0;
    const provider = {
      async startSession() {
        starts += 1;
        throw new Error("Frida must not start for invalid input");
      },
    } as unknown as FridaInstrumentationPort;
    const cli = createCli({}, undefined, provider);
    let stdout = "";
    await cli.serve(["instrument-with-frida", ...argv, "--json"], {
      env: {},
      exit: () => undefined,
      stdout: (text) => {
        stdout += text;
      },
    });
    expect(JSON.parse(stdout)).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [{ path: [path], reason: "invalid_value", message }],
      },
    });
    expect(starts).toBe(0);
  },
);
