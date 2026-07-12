import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startLoopbackReplay } from "../src/application/LoopbackReplay.js";
import {
  captureProcessScenario,
  probeProcessCaptureCapability,
  ProcessCaptureError,
} from "../src/application/ProcessHarness.js";
import {
  authorizeProcessScenario,
  compareProcessCaptures,
  parseProcessScenario,
  type ProcessExecutionPolicy,
} from "../src/domain/processCapture.js";

describe("process capture domain", () => {
  const base = {
    approved: true as const,
    executable: "/bin/sh",
    working_directory: "/tmp",
  };

  it("parses bounded scenarios and rejects unordered events", () => {
    expect(parseProcessScenario(base).timeout_ms).toBe(30_000);
    expect(() =>
      parseProcessScenario({
        ...base,
        events: [
          { type: "input", at_ms: 2, data: "a" },
          { type: "input", at_ms: 1, data: "b" },
        ],
      }),
    ).toThrow(/ordered/);
  });

  it("refuses paths and environment outside operator policy", () => {
    const scenario = parseProcessScenario({
      ...base,
      environment: { TOKEN: "secret" },
    });
    expect(
      authorizeProcessScenario(scenario, {
        enabled: true,
        executableRoots: ["/bin"],
        workingRoots: ["/tmp"],
        allowedEnvironment: [],
      }),
    ).toEqual({
      allowed: false,
      reason: "scenario requests an environment variable not allowed by policy",
    });
  });

  it("never considers truncated captures equivalent", () => {
    const capture = {
      schema_version: 1 as const,
      frames: [],
      exit: { code: 0, signal: null },
      process_samples: [],
      protocol_events: [],
      files_before: [],
      files_after: [],
      truncated: true,
      limitations: [],
    };
    expect(compareProcessCaptures(capture, capture).status).toBe("truncated");
  });
});

describe("process capture adapter", () => {
  it("serves bounded HTTP and WebSocket replay on loopback", async () => {
    const scenario = parseProcessScenario({
      approved: true,
      executable: "/bin/sh",
      working_directory: "/tmp",
      replay: {
        http: [{ method: "GET", path: "/ready", status: 201, body: "ready" }],
        websocket_messages: ["welcome"],
      },
    });
    const replay = await startLoopbackReplay(scenario);
    try {
      const response = await fetch(`${replay.httpUrl}/ready`);
      expect(response.status).toBe(201);
      expect(await response.text()).toBe("ready");
      const websocketMessage = await new Promise<string>(
        (resolveMessage, rejectMessage) => {
          const socket = new WebSocket(replay.websocketUrl);
          socket.once("message", (value) => {
            resolveMessage(value.toString());
            socket.close();
          });
          socket.once("error", rejectMessage);
        },
      );
      expect(websocketMessage).toBe("welcome");
      expect(replay.events.map((event) => event.protocol)).toContain(
        "websocket",
      );
    } finally {
      await replay.close();
    }
  });

  it("captures PTY, filesystem, descendants, HTTP replay, and redacts environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-harness-test-"));
    const script = join(root, "fixture.mjs");
    await writeFile(
      script,
      [
        'import { writeFile } from "node:fs/promises";',
        'import { spawn } from "node:child_process";',
        'await writeFile(new URL("result.txt", `file://${process.cwd()}/`), "created");',
        "const response = await fetch(`${process.env.REA_REPLAY_HTTP_URL}/probe`);",
        "console.log(`reply:${await response.text()}`);",
        "console.log(`sensitive:${process.env.SECRET}`);",
        'const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 150)"], { stdio: "ignore" });',
        "await new Promise((resolve) => setTimeout(resolve, 80));",
        "child.kill();",
      ].join("\n"),
    );
    const policy: ProcessExecutionPolicy = {
      enabled: true,
      executableRoots: [dirname(process.execPath)],
      workingRoots: [root],
      allowedEnvironment: ["SECRET"],
    };
    const scenario = parseProcessScenario({
      approved: true,
      executable: process.execPath,
      arguments: [script],
      working_directory: root,
      filesystem_roots: [root],
      environment: { SECRET: "do-not-record" },
      secret_aliases: ["SECRET"],
      replay: {
        http: [{ method: "GET", path: "/probe", status: 200, body: "ok" }],
      },
    });
    try {
      const capability = await probeProcessCaptureCapability();
      if (!capability.available) {
        expect(capability.reason).toMatch(/native PTY/);
        return;
      }
      const capture = await captureProcessScenario(scenario, policy);
      expect(capture.ok).toBe(true);
      if (!capture.ok) throw capture.error;
      expect(
        capture.value.frames.map((frame) => frame.data).join(""),
      ).toContain("reply:ok");
      expect(
        capture.value.frames.map((frame) => frame.data).join(""),
      ).toContain("sensitive:<redacted>");
      expect(
        capture.value.files_after.some((file) =>
          file.path.endsWith("result.txt"),
        ),
      ).toBe(true);
      expect(
        capture.value.protocol_events.some(
          (event) => event.protocol === "http" && event.path === "/probe",
        ),
      ).toBe(true);
      expect(JSON.stringify(capture.value)).not.toContain("do-not-record");
      expect(await readFile(join(root, "result.txt"), "utf8")).toBe("created");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not launch when policy denies capture", async () => {
    const scenario = parseProcessScenario({
      approved: true,
      executable: "/bin/sh",
      working_directory: "/tmp",
    });
    const result = await captureProcessScenario(scenario, {
      enabled: false,
      executableRoots: [],
      workingRoots: [],
      allowedEnvironment: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected policy refusal");
    expect(result.error).toBeInstanceOf(ProcessCaptureError);
  });
});
