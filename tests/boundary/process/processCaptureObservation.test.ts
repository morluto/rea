import { expect, it } from "vitest";

import { snapshotRoots } from "../../../src/application/FilesystemSnapshot.js";
import {
  buildCaptureResult,
  prepareProcessCapture,
  type ProcessPreparationHost,
} from "../../../src/application/ProcessCaptureLifecycle.js";
import { ProcessCheckpoints } from "../../../src/application/ProcessCheckpoints.js";
import { normalizeProcessSamples } from "../../../src/application/ProcessNormalization.js";
import {
  isInitializedPtyRoot,
  readLinuxChildren,
} from "../../../src/application/ProcessSampling.js";
import { TerminalRenderer } from "../../../src/application/TerminalRenderer.js";
import {
  authorizeProcessScenario,
  compareProcessCaptures,
  parseProcessCapture,
  parseProcessScenario,
  type ProcessCapture,
} from "../../../src/domain/processCapture.js";
import { emptyProcessCapture as emptyCapture } from "../../fixtures/processCapture.js";

const base = {
  approved: true as const,
  executable: "/bin/sh",
  working_directory: "/tmp",
};

it("returns detached terminal and filesystem checkpoint observations", async () => {
  const observed: string[] = [];
  const renderer = new TerminalRenderer({
    columns: 40,
    rows: 12,
    scrollback: 100,
    maxFrames: 10,
    maxBytes: 10_000,
    normalize: (value) => value,
    recordEvent: (collection, index) =>
      observed.push(`${collection}:${String(index)}`),
  });
  renderer.write("A", 20);
  renderer.resize(40, 12, 10);
  const frames = await renderer.frames();
  expect(frames.map(({ at_ms }) => at_ms)).toEqual([20, 10]);
  expect(observed).toEqual(["rendered_frames:0", "rendered_frames:1"]);
  if (frames[0] !== undefined) Reflect.set(frames[0], "cursor_x", 999);
  expect((await renderer.frames())[0]?.cursor_x).not.toBe(999);
  await renderer.dispose();

  const scenario = parseProcessScenario(base);
  const checkpoints = new ProcessCheckpoints(
    scenario,
    Date.now(),
    { files: [], truncated: false },
    { signal: undefined },
  );
  const first = await checkpoints.finish({ files: [], truncated: false });
  if (first[0] !== undefined) Reflect.set(first[0], "name", "tampered");
  const second = await checkpoints.finish({ files: [], truncated: false });
  expect(second[0]?.name).toBe("before");
  await checkpoints.dispose();
});

it("preserves rendered observation order instead of timestamp sorting", () => {
  const capture = emptyCapture();
  const renderedFrames: ProcessCapture["rendered_frames"] = [
    {
      sequence: 0,
      at_ms: 20,
      columns: 1,
      rows: 1,
      cursor_x: 0,
      cursor_y: 0,
      active_buffer: "normal",
      lines: ["first"],
      serialized_state: "first",
    },
    {
      sequence: 1,
      at_ms: 10,
      columns: 1,
      rows: 1,
      cursor_x: 0,
      cursor_y: 0,
      active_buffer: "normal",
      lines: ["second"],
      serialized_state: "second",
    },
  ];
  const result = buildCaptureResult({
    frames: [],
    exit: { exitCode: 0, reason: "exited" },
    samples: [],
    replay: {
      httpUrl: "http://127.0.0.1",
      websocketUrl: "ws://127.0.0.1/ws",
      events: [],
      transitions: [],
      truncated: false,
      close: () => Promise.resolve(),
    },
    before: { files: [], truncated: false },
    after: { files: [], truncated: false },
    truncated: false,
    scenario: parseProcessScenario(base),
    rootPid: 1,
    samplingPartial: false,
    renderedFrames,
    interactions: [],
    checkpoints: capture.filesystem_checkpoints,
    shimEvents: [],
    settlement: {
      state: capture.settlement.state,
      elapsed_ms: capture.settlement.elapsed_ms,
    },
    manifest: capture.manifest,
    eventJournal: [],
  });

  expect(result.rendered_frames).toEqual(renderedFrames);
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
        status: "enabled",
        executableRoots: ["/bin"],
        workingRoots: ["/tmp"],
        allowedEnvironment: [],
        networkAccess: "external",
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

it("admits PTY samples only after stable session and token setup", () => {
  const initialized = {
    pid: 100,
    parent_pid: 10,
    process_group_id: 100,
    session_id: 100,
    startTime: "200",
  };
  expect(
    isInitializedPtyRoot({
      rootPid: 100,
      expectedRunId: "run-token",
      before: { ...initialized, process_group_id: 10, session_id: 10 },
      observedRunId: undefined,
      after: initialized,
    }),
  ).toBe(false);
  expect(
    isInitializedPtyRoot({
      rootPid: 100,
      expectedRunId: "run-token",
      before: initialized,
      observedRunId: "run-token",
      after: { ...initialized, startTime: "201" },
    }),
  ).toBe(false);
  expect(
    isInitializedPtyRoot({
      rootPid: 100,
      expectedRunId: "run-token",
      before: initialized,
      observedRunId: "run-token",
      after: initialized,
    }),
  ).toBe(true);
  expect(
    isInitializedPtyRoot({
      rootPid: 100,
      expectedRunId: "run-token",
      before: { ...initialized, session_id: null },
      observedRunId: "run-token",
      after: { ...initialized, session_id: null },
    }),
  ).toBe(true);
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
    residual_unknowns: [{ scope: "shim", reason: "Shim capture was partial." }],
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
      status: "enabled",
      executableRoots: ["/bin"],
      workingRoots: ["/tmp"],
      allowedEnvironment: [],
      networkAccess: "none",
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
      status: "enabled",
      executableRoots: ["/bin"],
      workingRoots: ["/tmp"],
      allowedEnvironment: [],
      networkAccess: "external",
    }),
  ).toEqual({
    allowed: false,
    reason: "scenario requests an environment variable not allowed by policy",
  });
});
