import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  captureProcessScenario,
  probeProcessCaptureCapability,
} from "../../../src/application/ProcessHarness.js";
import {
  digestProcessCommitment,
  parseProcessScenario,
  type ProcessExecutionPolicy,
} from "../../../src/domain/processCapture.js";

it("runs a login and reconnect replay machine inside process capture", async () => {
  const root = await createTestTempDirectory("rea-replay-machine-test-");
  const script = join(root, "client.mjs");
  await writeFile(
    script,
    [
      'const token = "machine-secret";',
      'await fetch(`${process.env.REA_REPLAY_HTTP_URL}/login`, { method: "POST", body: JSON.stringify({ token }) });',
      "const api = await fetch(`${process.env.REA_REPLAY_HTTP_URL}/api`, { headers: { authorization: token } });",
      'if (await api.text() !== "connect") throw new Error("bad API response");',
      "const connect = (acknowledge) => new Promise((resolve, reject) => {",
      "  const socket = new WebSocket(process.env.REA_REPLAY_WEBSOCKET_URL);",
      "  socket.addEventListener('error', reject);",
      "  socket.addEventListener('message', (event) => {",
      "    if (acknowledge) socket.send('ack');",
      "    else { console.log(`reply:${event.data}`); socket.close(); resolve(); }",
      "  });",
      "  if (acknowledge) socket.addEventListener('close', () => resolve());",
      "});",
      "await connect(true);",
      "await connect(false);",
    ].join("\n"),
  );
  const scenario = parseProcessScenario({
    approved: true,
    executable: process.execPath,
    arguments: [script],
    working_directory: root,
    replay: {
      machine: {
        initial_state: "login",
        states: [
          { name: "login" },
          { name: "api" },
          { name: "socket" },
          { name: "ack" },
          { name: "reconnect" },
          { name: "complete", terminal: true },
        ],
        transitions: [
          {
            id: "login",
            from: "login",
            to: "api",
            trigger: { protocol: "http", method: "POST", path: "/login" },
            captures: [
              {
                variable: "token",
                value: { source: "request_json", path: ["token"] },
                sensitive: true,
              },
            ],
            actions: [{ type: "http_response", status: 204, body: "" }],
            max_uses: 1,
          },
          {
            id: "api",
            from: "api",
            to: "socket",
            trigger: { protocol: "http", method: "GET", path: "/api" },
            guards: [
              {
                variable: "token",
                value: { source: "request_header", name: "authorization" },
              },
            ],
            actions: [{ type: "http_response", status: 200, body: "connect" }],
            max_uses: 1,
          },
          {
            id: "initial_socket",
            from: "socket",
            to: "ack",
            trigger: { protocol: "websocket_connect", path: "/ws" },
            actions: [{ type: "websocket_send", data: "welcome" }],
            max_uses: 1,
          },
          {
            id: "ack",
            from: "ack",
            to: "reconnect",
            trigger: {
              protocol: "websocket_message",
              path: "/ws",
              body: "ack",
            },
            actions: [{ type: "disconnect" }],
            max_uses: 1,
          },
          {
            id: "reconnect",
            from: "reconnect",
            to: "complete",
            trigger: { protocol: "websocket_connect", path: "/ws" },
            actions: [{ type: "websocket_send", data: "done" }],
            max_uses: 1,
          },
        ],
        max_transitions: 5,
      },
    },
  });
  try {
    const capability = await probeProcessCaptureCapability();
    if (!capability.available) return;
    const capture = await captureProcessScenario(scenario, {
      status: "enabled",
      executableRoots: [dirname(process.execPath)],
      workingRoots: [root],
      allowedEnvironment: [],
      networkAccess: "external",
    });
    expect(capture.ok).toBe(true);
    if (!capture.ok) throw capture.error;
    expect(
      capture.value.replay_transitions.map(
        ({ transition_id }) => transition_id,
      ),
    ).toEqual(["login", "api", "initial_socket", "ack", "reconnect"]);
    expect(capture.value.frames.map(({ data }) => data).join("")).toContain(
      "reply:done",
    );
    expect(JSON.stringify(capture.value)).not.toContain("machine-secret");
    expect(capture.value.manifest.replay_plan_sha256).toBe(
      digestProcessCommitment(scenario.replay),
    );
    expect(
      capture.value.event_journal?.filter(
        ({ collection }) => collection === "replay_transitions",
      ),
    ).toHaveLength(capture.value.replay_transitions.length);
    for (const [index, entry] of (capture.value.event_journal ?? []).entries())
      if (entry.collection === "replay_transitions")
        expect(capture.value.event_journal?.[index - 1]?.collection).toBe(
          "protocol_events",
        );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

it("captures PTY, filesystem, descendants, HTTP replay, and redacts environment", async () => {
  const root = await createTestTempDirectory("rea-harness-test-");
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
    status: "enabled",
    executableRoots: [dirname(process.execPath)],
    workingRoots: [root],
    allowedEnvironment: ["SECRET"],
    networkAccess: "external",
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
    expect(capture.value.frames.map((frame) => frame.data).join("")).toContain(
      "reply:ok",
    );
    expect(capture.value.frames.map((frame) => frame.data).join("")).toContain(
      "sensitive:<redacted>",
    );
    expect(
      capture.value.files_after.some((file) =>
        file.path.endsWith("result.txt"),
      ),
    ).toBe(true);
    expect(
      capture.value.filesystem_effects.some(
        (effect) =>
          effect.path.endsWith(":result.txt") && effect.status === "created",
      ),
    ).toBe(true);
    expect(
      capture.value.protocol_events.some(
        (event) => event.protocol === "http" && event.path === "/probe",
      ),
    ).toBe(true);
    expect(JSON.stringify(capture.value)).not.toContain("do-not-record");
    expect(await readFile(join(root, "result.txt"), "utf8")).toBe("created");
    expect(JSON.stringify(capture.value.files_after)).not.toContain(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
