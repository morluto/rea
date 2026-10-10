import { expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import type { FridaInstrumentationPort } from "../../../src/application/frida/FridaInstrumentationPort.js";

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
        scripts: [],
        messages: [],
        messagesTruncated: false,
      };
    },
    async closeSession(sessionId) {
      calls.push({ operation: "close", sessionId });
      return { ok: true, value: null };
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
        remote: { address: "127.0.0.1:27042", token: "synthetic-secret-token" },
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
