import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startLoopbackReplay } from "../src/application/LoopbackReplay.js";
import {
  captureProcessScenario,
  probeProcessCaptureCapability,
  ProcessCaptureError,
} from "../src/application/ProcessHarness.js";
import { snapshotRoots } from "../src/application/FilesystemSnapshot.js";
import {
  prepareProcessCapture,
  type ProcessPreparationHost,
} from "../src/application/ProcessCaptureLifecycle.js";
import { ProcessCheckpoints } from "../src/application/ProcessCheckpoints.js";
import { normalizeProcessSamples } from "../src/application/ProcessNormalization.js";
import { readLinuxChildren } from "../src/application/ProcessSampling.js";
import { TerminalRenderer } from "../src/application/TerminalRenderer.js";
import {
  authorizeProcessScenario,
  compareProcessCaptures,
  digestProcessCommitment,
  LEGACY_PROCESS_CAPTURE_MESSAGE,
  parseProcessCapture,
  parseProcessScenario,
  processCaptureSchema,
  type ProcessCapture,
  type ProcessExecutionPolicy,
} from "../src/domain/processCapture.js";

const processFixture = fileURLToPath(
  new URL("./fixtures/processFidelity.mjs", import.meta.url),
);
const execFileAsync = promisify(execFile);

const emptyCapture = (): ProcessCapture => {
  const normalization = {
    paths: true,
    pids: true,
    ports: true,
    time_bucket_ms: 10,
    patterns: [],
  };
  const scenario = { executable_sha256: "0".repeat(64) };
  const comparisonContract = {};
  const shimPlan: readonly unknown[] = [];
  const replayPlan = {};
  return {
    schema_version: 4,
    manifest: {
      rea_version: "test",
      provider_version: "3",
      platform: process.platform,
      architecture: process.arch,
      pty_backend: "node-pty",
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: "2026-01-01T00:00:00.001Z",
      scenario,
      comparison_contract: comparisonContract,
      shim_plan: shimPlan,
      replay_plan: replayPlan,
      full_scenario_sha256: digestProcessCommitment(scenario),
      comparison_contract_sha256: digestProcessCommitment(comparisonContract),
      executable_sha256: "0".repeat(64),
      normalization_sha256: digestProcessCommitment(normalization),
      shim_plan_sha256: digestProcessCommitment(shimPlan),
      replay_plan_sha256: digestProcessCommitment(replayPlan),
    },
    normalization,
    frames: [],
    rendered_frames: [],
    interaction_events: [],
    exit: { code: 0, signal: null, reason: "exited" },
    settlement: {
      state: "quiesced",
      elapsed_ms: 50,
      cleanup_outcome: "not_required",
    },
    process_samples: [],
    filesystem_checkpoints: [
      { name: "before", at_ms: 0, files: [], effects: [], truncated: false },
      {
        name: "after_settlement",
        at_ms: 50,
        files: [],
        effects: [],
        truncated: false,
      },
    ],
    shim_events: [],
    protocol_events: [],
    files_before: [],
    files_after: [],
    filesystem_effects: [],
    truncated: false,
    limitations: [],
    residual_unknowns: [],
    cleanup: {
      owned_process_group: "verified",
      temporary_root: "removed",
    },
  };
};

describe("process capture domain", () => {
  const base = {
    approved: true as const,
    executable: "/bin/sh",
    working_directory: "/tmp",
  };

  it("returns detached terminal and filesystem checkpoint observations", async () => {
    const renderer = new TerminalRenderer({
      columns: 40,
      rows: 12,
      scrollback: 100,
      maxFrames: 10,
      maxBytes: 10_000,
      normalize: (value) => value,
    });
    renderer.write("A", 0);
    const frames = await renderer.frames();
    if (frames[0] !== undefined) Reflect.set(frames[0], "cursor_x", 999);
    expect((await renderer.frames())[0]?.cursor_x).not.toBe(999);
    await renderer.dispose();

    const scenario = parseProcessScenario(base);
    const checkpoints = new ProcessCheckpoints(
      scenario,
      Date.now(),
      { files: [], truncated: false },
      undefined,
    );
    const first = await checkpoints.finish({ files: [], truncated: false });
    if (first[0] !== undefined) Reflect.set(first[0], "name", "tampered");
    const second = await checkpoints.finish({ files: [], truncated: false });
    expect(second[0]?.name).toBe("before");
    await checkpoints.dispose();
  });

  it("cleans the temporary root when capture home creation fails", async () => {
    const cleaned: string[] = [];
    const host: ProcessPreparationHost = {
      createTemporaryRoot: () => Promise.resolve("/tmp/rea-process-fixture"),
      createHome: () => Promise.reject(new Error("mkdir failed")),
      cleanup: (path) => {
        cleaned.push(path);
        return Promise.resolve();
      },
    };

    await expect(
      prepareProcessCapture(
        parseProcessScenario(base),
        {
          enabled: true,
          executableRoots: ["/bin"],
          workingRoots: ["/tmp"],
          allowedEnvironment: [],
          allowExternalNetwork: true,
        },
        undefined,
        host,
      ),
    ).rejects.toThrow("mkdir failed");
    expect(cleaned).toEqual(["/tmp/rea-process-fixture"]);
  });

  it("normalizes every sampled process identifier in command text", () => {
    const samples = normalizeProcessSamples(
      [
        {
          at_ms: 0,
          pid: 101,
          parent_pid: 0,
          process_group_id: 101,
          session_id: 101,
          command: "root 101",
        },
        {
          at_ms: 10,
          pid: 202,
          parent_pid: 101,
          process_group_id: 101,
          session_id: 101,
          command: "child 202 peer=101 unrelated 1202",
        },
      ],
      parseProcessScenario(base),
      101,
    );

    expect(samples[1]?.command).toBe("child <pid> peer=<pid> unrelated 1202");
  });

  it("collects and deduplicates children from every Linux thread", async () => {
    const signal = new AbortController().signal;
    expect(
      await readLinuxChildren(100, signal, {
        taskIds: () => Promise.resolve([100, 101, 102]),
        children: (_pid, taskId) =>
          Promise.resolve(
            taskId === 100 ? "201 202" : taskId === 101 ? "202 203" : "",
          ),
      }),
    ).toEqual([201, 202, 203]);
  });

  it("keeps interaction and shim residual uncertainty in separate scopes", () => {
    const baseCapture = emptyCapture();
    const interaction = parseProcessCapture({
      ...baseCapture,
      residual_unknowns: [
        { scope: "interaction", reason: "Interaction capture was partial." },
      ],
    });
    const shim = parseProcessCapture({
      ...baseCapture,
      residual_unknowns: [
        { scope: "shim", reason: "Shim capture was partial." },
      ],
    });

    expect(compareProcessCaptures(interaction, baseCapture)).toMatchObject({
      status: "unknown",
      terminal: "unchanged",
      interaction: "unknown",
      shim: "unchanged",
    });
    expect(compareProcessCaptures(shim, baseCapture)).toMatchObject({
      status: "unknown",
      terminal: "unchanged",
      interaction: "unchanged",
      shim: "unknown",
    });
  });

  it("cancels filesystem snapshots before traversing declared roots", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      snapshotRoots(
        parseProcessScenario({
          ...base,
          filesystem_roots: ["/tmp"],
        }),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

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
    expect(() =>
      parseProcessScenario({
        ...base,
        environment: { HOME: "/unsafe" },
      }),
    ).toThrow(/reserved/);
    expect(() =>
      parseProcessScenario({
        ...base,
        events: [{ type: "input", at_ms: 31_000, data: "late" }],
      }),
    ).toThrow(/after the scenario timeout/);
  });

  it("requires explicit operator approval for host network access", () => {
    expect(
      authorizeProcessScenario(parseProcessScenario(base), {
        enabled: true,
        executableRoots: ["/bin"],
        workingRoots: ["/tmp"],
        allowedEnvironment: [],
        allowExternalNetwork: false,
      }),
    ).toEqual({
      allowed: false,
      reason: "host network access is not approved by operator policy",
    });
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
        allowExternalNetwork: true,
      }),
    ).toEqual({
      allowed: false,
      reason: "scenario requests an environment variable not allowed by policy",
    });
  });

  it("never considers truncated captures equivalent", () => {
    const capture = {
      schema_version: 4 as const,
      manifest: emptyCapture().manifest,
      settlement: emptyCapture().settlement,
      normalization: {
        paths: true,
        pids: true,
        ports: true,
        time_bucket_ms: 10,
        patterns: [],
      },
      frames: [],
      rendered_frames: [],
      interaction_events: [],
      exit: { code: 0, signal: null, reason: "exited" as const },
      process_samples: [],
      filesystem_checkpoints: emptyCapture().filesystem_checkpoints,
      shim_events: [],
      protocol_events: [],
      files_before: [],
      files_after: [],
      filesystem_effects: [],
      truncated: true,
      limitations: [],
      residual_unknowns: [],
      cleanup: {
        owned_process_group: "verified" as const,
        temporary_root: "removed" as const,
      },
    };
    expect(compareProcessCaptures(capture, capture).status).toBe("truncated");
  });

  it("rejects altered v4 commitments and accepts canonical key reordering", () => {
    const capture = emptyCapture();
    expect(parseProcessCapture(capture)).toEqual(capture);
    expect(digestProcessCommitment({ second: 2, first: 1 })).toBe(
      digestProcessCommitment({ first: 1, second: 2 }),
    );
    expect(() =>
      parseProcessCapture({
        ...capture,
        manifest: {
          ...capture.manifest,
          normalization_sha256: "f".repeat(64),
        },
      }),
    ).toThrow("normalization_sha256");
    expect(() =>
      parseProcessCapture({
        ...capture,
        manifest: {
          ...capture.manifest,
          executable_sha256: "f".repeat(64),
        },
      }),
    ).toThrow("executable_sha256");
  });

  it("tells agents and users to recapture unsupported v3 evidence", () => {
    const legacy = { ...emptyCapture(), schema_version: 3 };
    expect(() => parseProcessCapture(legacy)).toThrow(
      LEGACY_PROCESS_CAPTURE_MESSAGE,
    );
    const parsed = processCaptureSchema.safeParse(legacy);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected legacy capture rejection");
    expect(parsed.error.issues[0]?.message).toBe(
      LEGACY_PROCESS_CAPTURE_MESSAGE,
    );
  });

  it("requires compatible contracts and enforces capture age through a clock seam", () => {
    const capture = emptyCapture();
    expect(() =>
      compareProcessCaptures(capture, {
        ...capture,
        manifest: {
          ...capture.manifest,
          comparison_contract: { changed: true },
          comparison_contract_sha256: digestProcessCommitment({
            changed: true,
          }),
        },
      }),
    ).toThrow("incompatible comparison contracts");
    expect(() =>
      compareProcessCaptures(capture, capture, {
        maxCaptureAgeMs: 1,
        now: () => Date.parse("2026-01-01T00:00:01.000Z"),
      }),
    ).toThrow("max_capture_age_ms");
  });

  it("classifies missing observations as unknown and one-sided evidence as added", () => {
    const base = {
      schema_version: 4 as const,
      manifest: emptyCapture().manifest,
      settlement: emptyCapture().settlement,
      normalization: {
        paths: true,
        pids: true,
        ports: true,
        time_bucket_ms: 10,
        patterns: [],
      },
      frames: [],
      rendered_frames: [],
      interaction_events: [],
      exit: { code: 0, signal: null, reason: "exited" as const },
      process_samples: [],
      filesystem_checkpoints: emptyCapture().filesystem_checkpoints,
      shim_events: [],
      protocol_events: [],
      files_before: [],
      files_after: [],
      filesystem_effects: [],
      truncated: false,
      limitations: [],
      residual_unknowns: [],
      cleanup: {
        owned_process_group: "verified" as const,
        temporary_root: "removed" as const,
      },
    };
    const added = compareProcessCaptures(base, {
      ...base,
      frames: [{ sequence: 0, at_ms: 0, data: "new" }],
      rendered_frames: [
        {
          sequence: 0,
          at_ms: 0,
          columns: 3,
          rows: 1,
          cursor_x: 3,
          cursor_y: 0,
          active_buffer: "normal",
          lines: ["new"],
          serialized_state: "new",
        },
      ],
    });
    expect(added.terminal).toBe("added");
    expect(added.status).toBe("changed");
    const unknown = compareProcessCaptures(
      { ...base, residual_unknowns: [{ scope: "process", reason: "sampled" }] },
      base,
    );
    expect(unknown.process).toBe("unknown");
    expect(unknown.shim).toBe("unchanged");
    expect(unknown.status).toBe("unknown");
  });

  it("compares raw terminal chunks even when rendered states agree", () => {
    const capture = {
      schema_version: 4 as const,
      manifest: emptyCapture().manifest,
      settlement: emptyCapture().settlement,
      normalization: {
        paths: true,
        pids: true,
        ports: true,
        time_bucket_ms: 10,
        patterns: [],
      },
      frames: [{ sequence: 0, at_ms: 0, data: "bar" }],
      rendered_frames: [],
      interaction_events: [],
      exit: { code: 0, signal: null, reason: "exited" as const },
      process_samples: [],
      filesystem_checkpoints: emptyCapture().filesystem_checkpoints,
      shim_events: [],
      protocol_events: [],
      files_before: [],
      files_after: [],
      filesystem_effects: [],
      truncated: false,
      limitations: [],
      residual_unknowns: [],
      cleanup: {
        owned_process_group: "verified" as const,
        temporary_root: "removed" as const,
      },
    };

    const comparison = compareProcessCaptures(capture, {
      ...capture,
      frames: [{ sequence: 0, at_ms: 0, data: "foo\rbar" }],
    });
    expect(comparison.terminal).toBe("changed");
    expect(comparison.first_divergence).toMatchObject({
      status: "found",
      dimension: "terminal",
    });
  });

  it("keeps filesystem evidence unknown when stable snapshots match", () => {
    const capture = {
      schema_version: 4 as const,
      manifest: emptyCapture().manifest,
      settlement: emptyCapture().settlement,
      normalization: {
        paths: true,
        pids: true,
        ports: true,
        time_bucket_ms: 10,
        patterns: [],
      },
      frames: [],
      rendered_frames: [],
      interaction_events: [],
      exit: { code: 0, signal: null, reason: "exited" as const },
      process_samples: [],
      filesystem_checkpoints: emptyCapture().filesystem_checkpoints,
      shim_events: [],
      protocol_events: [],
      files_before: [],
      files_after: [],
      filesystem_effects: [],
      truncated: false,
      limitations: [],
      residual_unknowns: [
        { scope: "filesystem" as const, reason: "watcher unavailable" },
      ],
      cleanup: {
        owned_process_group: "verified" as const,
        temporary_root: "removed" as const,
      },
    };

    const comparison = compareProcessCaptures(capture, capture);
    expect(comparison.filesystem).toBe("unknown");
    expect(comparison.status).toBe("unknown");

    const complete = { ...capture, residual_unknowns: [] };
    const transient = compareProcessCaptures(complete, {
      ...complete,
      filesystem_checkpoints: [
        { name: "before", at_ms: 0, files: [], effects: [], truncated: false },
        {
          name: "during_run",
          at_ms: 10,
          files: [],
          effects: [],
          truncated: false,
        },
        {
          name: "after_settlement",
          at_ms: 50,
          files: [],
          effects: [],
          truncated: false,
        },
      ],
    });
    expect(transient.filesystem).toBe("changed");
    expect(transient.status).toBe("changed");
  });

  it("detects changes in normalized process sample metadata", () => {
    const capture = {
      schema_version: 4 as const,
      manifest: emptyCapture().manifest,
      settlement: emptyCapture().settlement,
      normalization: {
        paths: true,
        pids: true,
        ports: true,
        time_bucket_ms: 10,
        patterns: [],
      },
      frames: [],
      rendered_frames: [],
      interaction_events: [],
      exit: { code: 0, signal: null, reason: "exited" as const },
      process_samples: [
        {
          at_ms: 10,
          pid: 1,
          parent_pid: 0,
          process_group_id: 1,
          session_id: 1,
          command: "worker",
        },
      ],
      filesystem_checkpoints: emptyCapture().filesystem_checkpoints,
      shim_events: [],
      protocol_events: [],
      files_before: [],
      files_after: [],
      filesystem_effects: [],
      truncated: false,
      limitations: [],
      residual_unknowns: [],
      cleanup: {
        owned_process_group: "verified" as const,
        temporary_root: "removed" as const,
      },
    };
    const changed = {
      ...capture,
      process_samples: [
        {
          at_ms: 20,
          pid: 1,
          parent_pid: 2,
          process_group_id: 1,
          session_id: 1,
          command: "worker",
        },
      ],
    };

    const comparison = compareProcessCaptures(capture, changed);
    expect(comparison.process).toBe("changed");
    expect(comparison.status).toBe("changed");
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

  it("matches bounded HTTP scripts without persisting request secrets", async () => {
    const scenario = parseProcessScenario({
      approved: true,
      executable: "/bin/sh",
      working_directory: "/tmp",
      replay: {
        http: [
          {
            method: "POST",
            path: "/callback",
            request_headers: { authorization: "Bearer fixture-secret" },
            request_body: "credential-body",
            status: 302,
            response_headers: { location: "/done" },
            body: "redirecting",
            max_calls: 1,
          },
          {
            method: "GET",
            path: "/disconnect",
            status: 200,
            body: "",
            disconnect: true,
          },
        ],
      },
    });
    const replay = await startLoopbackReplay(scenario);
    try {
      const request = () =>
        fetch(`${replay.httpUrl}/callback`, {
          method: "POST",
          headers: { authorization: "Bearer fixture-secret" },
          body: "credential-body",
          redirect: "manual",
        });
      const matched = await request();
      expect(matched.status).toBe(302);
      expect(matched.headers.get("location")).toBe("/done");
      expect((await request()).status).toBe(409);
      expect((await fetch(`${replay.httpUrl}/missing`)).status).toBe(404);
      await expect(fetch(`${replay.httpUrl}/disconnect`)).rejects.toThrow();
      expect(replay.events.map(({ outcome }) => outcome)).toEqual(
        expect.arrayContaining([
          "matched",
          "script_exhausted",
          "unmatched",
          "disconnected",
        ]),
      );
      expect(JSON.stringify(replay.events)).not.toContain("fixture-secret");
      expect(JSON.stringify(replay.events)).not.toContain("credential-body");
    } finally {
      await replay.close();
    }
  });

  it("consumes ordered WebSocket reconnect scripts and reports exhaustion", async () => {
    const scenario = parseProcessScenario({
      approved: true,
      executable: "/bin/sh",
      working_directory: "/tmp",
      replay: {
        websocket_connections: [
          {
            messages: [{ data: "first", delay_ms: 1 }],
            disconnect_after: true,
          },
          {
            messages: [{ data: "second" }],
            disconnect_after: true,
          },
        ],
      },
    });
    const replay = await startLoopbackReplay(scenario);
    const receive = () =>
      new Promise<string>((resolveMessage, rejectMessage) => {
        const socket = new WebSocket(replay.websocketUrl);
        socket.once("message", (value) => resolveMessage(value.toString()));
        socket.once("error", rejectMessage);
      });
    try {
      await expect(receive()).resolves.toBe("first");
      await expect(receive()).resolves.toBe("second");
      await new Promise<void>((resolveClose, rejectClose) => {
        const socket = new WebSocket(replay.websocketUrl);
        socket.once("close", () => resolveClose());
        socket.once("error", rejectClose);
      });
      expect(replay.events.at(-1)?.outcome).toBe("script_exhausted");
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
      allowExternalNetwork: true,
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

  it("renders terminal state, records shim invocations, and captures literal checkpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-v3-test-"));
    const script = join(root, "scenario.mjs");
    await writeFile(
      script,
      [
        'import { spawnSync } from "node:child_process";',
        'const result = spawnSync("codex", ["--version"], { encoding: "utf8" });',
        'const node = spawnSync("node", ["--version"], { encoding: "utf8" });',
        "process.stdout.write(`probe:${result.stdout}`);",
        "process.stdout.write(`runtime:${node.stdout}`);",
      ].join("\n"),
    );
    try {
      const capability = await probeProcessCaptureCapability();
      if (!capability.available) return;
      const result = await captureProcessScenario(
        parseProcessScenario({
          approved: true,
          executable: process.execPath,
          arguments: [script],
          working_directory: root,
          filesystem_roots: [root],
          checkpoints: [
            {
              name: "probe_seen",
              trigger: { type: "terminal_literal", value: "probe:codex 1.2.3" },
            },
          ],
          command_shims: [
            {
              name: "codex",
              routes: [
                {
                  arguments: ["--version"],
                  outputs: [
                    { at_ms: 0, stream: "stdout", data: "codex 1.2.3\n" },
                  ],
                  termination: { type: "exit", code: 0 },
                },
              ],
            },
            {
              name: "node",
              routes: [
                {
                  arguments: ["--version"],
                  outputs: [
                    { at_ms: 0, stream: "stdout", data: "node 9.8.7\n" },
                  ],
                  termination: { type: "exit", code: 0 },
                },
              ],
            },
          ],
        }),
        {
          enabled: true,
          executableRoots: [dirname(process.execPath)],
          workingRoots: [root],
          allowedEnvironment: [],
          allowExternalNetwork: true,
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      expect(result.value.schema_version).toBe(4);
      expect(result.value.rendered_frames.at(-1)?.lines.join("\n")).toContain(
        "probe:codex 1.2.3",
      );
      expect(result.value.shim_events).toEqual([
        expect.objectContaining({
          command: "codex",
          arguments: ["--version"],
          outcome: "matched",
        }),
        expect.objectContaining({
          command: "node",
          arguments: ["--version"],
          outcome: "matched",
        }),
      ]);
      expect(
        result.value.filesystem_checkpoints.map(({ name }) => name),
      ).toEqual(["before", "probe_seen", "after_settlement"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not follow or disclose symlink targets outside declared roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-symlink-test-"));
    await symlink("/etc/passwd", join(root, "escape"));
    try {
      const capability = await probeProcessCaptureCapability();
      if (!capability.available) return;
      const result = await captureProcessScenario(
        parseProcessScenario({
          approved: true,
          executable: "/usr/bin/true",
          working_directory: root,
          filesystem_roots: [root],
        }),
        {
          enabled: true,
          executableRoots: ["/usr/bin"],
          workingRoots: [root],
          allowedEnvironment: [],
          allowExternalNetwork: true,
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      const escaped = result.value.files_after.find((file) =>
        file.path.endsWith(":escape"),
      );
      expect(escaped?.symlink_target).toBe("<outside-declared-root>");
      expect(result.value.truncated).toBe(true);
      expect(JSON.stringify(result.value.files_after)).not.toContain(root);
      expect(JSON.stringify(result.value.files_after)).not.toContain(
        "/etc/passwd",
      );
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
      allowExternalNetwork: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected policy refusal");
    expect(result.error).toBeInstanceOf(ProcessCaptureError);
  });

  it("distinguishes timeout from cancellation and cleans both runs", async () => {
    const capability = await probeProcessCaptureCapability();
    if (!capability.available) return;
    const policy: ProcessExecutionPolicy = {
      enabled: true,
      executableRoots: [dirname(process.execPath)],
      workingRoots: [dirname(processFixture)],
      allowedEnvironment: [],
      allowExternalNetwork: true,
    };
    const timedOut = await captureProcessScenario(
      parseProcessScenario({
        approved: true,
        executable: process.execPath,
        arguments: [processFixture, "hang"],
        working_directory: dirname(processFixture),
        timeout_ms: 50,
        idle_timeout_ms: 5_000,
      }),
      policy,
    );
    expect(timedOut.ok).toBe(true);
    if (!timedOut.ok) throw timedOut.error;
    expect(timedOut.value.exit.reason).toBe("timeout");
    expect(timedOut.value.cleanup).toEqual({
      owned_process_group: "verified",
      temporary_root: "removed",
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const cancelled = await captureProcessScenario(
      parseProcessScenario({
        approved: true,
        executable: process.execPath,
        arguments: [processFixture, "hang"],
        working_directory: dirname(processFixture),
        timeout_ms: 5_000,
        idle_timeout_ms: 5_000,
      }),
      policy,
      controller.signal,
    );
    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) throw new Error("expected cancellation");
    expect(cancelled.error.message).toContain("cancelled");
  });

  it("captures source-owned interactive, resize, Unicode, and signal behavior", async () => {
    const capability = await probeProcessCaptureCapability();
    if (!capability.available) return;
    const result = await captureProcessScenario(
      parseProcessScenario({
        approved: true,
        executable: process.execPath,
        arguments: [processFixture, "interactive"],
        working_directory: dirname(processFixture),
        events: [
          { type: "input", at_ms: 100, data: "answer" },
          { type: "resize", at_ms: 300, columns: 100, rows: 40 },
          { type: "signal", at_ms: 700, signal: "SIGINT" },
        ],
        timeout_ms: 2_000,
        idle_timeout_ms: 2_000,
      }),
      {
        enabled: true,
        executableRoots: [dirname(process.execPath)],
        workingRoots: [dirname(processFixture)],
        allowedEnvironment: [],
        allowExternalNetwork: true,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    const output = result.value.frames.map(({ data }) => data).join("");
    expect(output).toContain("prompt>");
    expect(output).toContain("input:answer unicode:雪");
    expect(output).toContain("resize:100x40");
    expect(output).toContain("signal:SIGINT");
    expect(result.value.exit.code).toBe(0);
  });

  it("dispatches scheduled events before a silent PTY produces output", async () => {
    const capability = await probeProcessCaptureCapability();
    if (!capability.available) return;
    const result = await captureProcessScenario(
      parseProcessScenario({
        approved: true,
        executable: process.execPath,
        arguments: [processFixture, "silent-interactive"],
        working_directory: dirname(processFixture),
        events: [
          { type: "resize", at_ms: 25, columns: 100, rows: 40 },
          { type: "input", at_ms: 50, data: "answer" },
        ],
        timeout_ms: 2_000,
        idle_timeout_ms: 2_000,
      }),
      {
        enabled: true,
        executableRoots: [
          join(dirname(process.execPath), "missing"),
          dirname(process.execPath),
        ],
        workingRoots: [
          join(dirname(processFixture), "missing"),
          dirname(processFixture),
        ],
        allowedEnvironment: [],
        allowExternalNetwork: true,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.frames.map(({ data }) => data).join("")).toContain(
      "input:answer",
    );
    expect(result.value.interaction_events).toMatchObject([
      { type: "resize", outcome: "dispatched" },
      { type: "input", outcome: "dispatched" },
    ]);
  });

  it("samples and cleans a source-owned child and grandchild process tree", async () => {
    const capability = await probeProcessCaptureCapability();
    if (!capability.available) return;
    const result = await captureProcessScenario(
      parseProcessScenario({
        approved: true,
        executable: process.execPath,
        arguments: [processFixture, "tree"],
        working_directory: dirname(processFixture),
        timeout_ms: 2_000,
        idle_timeout_ms: 2_000,
      }),
      {
        enabled: true,
        executableRoots: [dirname(process.execPath)],
        workingRoots: [dirname(processFixture)],
        allowedEnvironment: [],
        allowExternalNetwork: true,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    const commands = result.value.process_samples.map(({ command }) => command);
    expect(commands.some((command) => command.includes("tree-child"))).toBe(
      true,
    );
    expect(
      commands.some((command) => command.includes("tree-grandchild")),
    ).toBe(true);
    expect(JSON.stringify(result.value.process_samples)).not.toContain(
      dirname(processFixture),
    );
    const { stdout } = await execFileAsync("ps", ["-axo", "command="]);
    expect(stdout).not.toContain(`${processFixture} tree-child`);
    expect(stdout).not.toContain(`${processFixture} tree-grandchild`);
  });
});
