import { expect, it } from "vitest";

import { snapshotRoots } from "./FilesystemSnapshot.js";
import { buildCaptureResult } from "./ProcessCaptureLifecycle.js";
import { isInitializedPtyRoot, readLinuxChildren } from "./ProcessSampling.js";
import { TerminalRenderer } from "./TerminalRenderer.js";
import {
  parseProcessScenario,
  type ProcessCapture,
} from "../../domain/process/processCapture.js";
import { emptyProcessCapture as emptyCapture } from "../../domain/process/processCapture.fixture.js";

const base = {
  executable: "/bin/sh",
  working_directory: "/tmp",
};

it("returns detached terminal observations", async () => {
  const observed: string[] = [];
  const renderer = new TerminalRenderer({
    columns: 40,
    rows: 12,
    scrollback: 100,
    maxBytes: 100_000,
    normalize: (value) => value,
    recordEvent: (collection, index) =>
      observed.push(`${collection}:${String(index)}`),
  });
  renderer.write("A", 20);
  renderer.resize(40, 12, 10);
  for (let index = 0; index < 20; index += 1)
    renderer.resize(40, 12, 11 + index);
  const frames = await renderer.frames();
  expect(frames).toHaveLength(22);
  expect(frames.slice(0, 2).map(({ at_ms }) => at_ms)).toEqual([20, 10]);
  expect(observed).toHaveLength(22);
  const frame = frames[0];
  if (frame === undefined) throw new Error("expected observed frame");
  const originalCursor = frame.cursor_x;
  Reflect.set(frame, "cursor_x", 999);
  const reread = await renderer.frames();
  expect(reread).toHaveLength(frames.length);
  expect(reread[0]?.cursor_x).toBe(originalCursor);
  await renderer.dispose();
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
    before: { files: [], truncated: false, completeRoots: [] },
    after: { files: [], truncated: false, completeRoots: [] },
    truncated: false,
    scenario: parseProcessScenario(base),
    rootPid: 1,
    samplingPartial: false,
    renderedFrames,
    interactions: [],
    checkpoints: capture.filesystem_checkpoints,
    settlement: {
      state: capture.settlement.state,
      elapsed_ms: capture.settlement.elapsed_ms,
    },
    manifest: capture.manifest,
    eventJournal: [],
  });

  expect(result.rendered_frames).toEqual(renderedFrames);
});

it("marks redacted scripted input as an interaction unknown", () => {
  const capture = emptyCapture();
  const result = buildCaptureResult({
    frames: [],
    exit: { exitCode: 0, reason: "exited" },
    samples: [],
    before: { files: [], truncated: false, completeRoots: [] },
    after: { files: [], truncated: false, completeRoots: [] },
    truncated: false,
    scenario: parseProcessScenario({
      ...base,
      events: [{ type: "input", at_ms: 0, data: "secret", sensitive: true }],
    }),
    rootPid: 1,
    samplingPartial: false,
    renderedFrames: [],
    interactions: [
      {
        sequence: 0,
        scheduled_at_ms: 0,
        dispatched_at_ms: 0,
        type: "input",
        data: "<redacted-input:6-bytes>",
        outcome: "dispatched",
      },
    ],
    checkpoints: capture.filesystem_checkpoints,
    settlement: {
      state: capture.settlement.state,
      elapsed_ms: capture.settlement.elapsed_ms,
    },
    manifest: capture.manifest,
    eventJournal: [],
  });

  expect(result.residual_unknowns).toContainEqual({
    scope: "interaction",
    reason:
      "Sensitive scripted input values are redacted from process capture Evidence.",
  });
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

it("cancels filesystem snapshots before traversing declared roots", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    snapshotRoots(
      parseProcessScenario({
        ...base,
        filesystem_observation_paths: ["/tmp"],
      }),
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
});
