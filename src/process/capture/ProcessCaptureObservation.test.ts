import { describe, expect, it } from "vitest";

import { failedInspectionDescriptor } from "../../../tests/fixtures/processInspectionCleanup.js";
import {
  ProcessCaptureSnapshotFailure,
  snapshotRoots,
} from "./FilesystemSnapshot.js";
import {
  buildCaptureResult,
  POSIX_PTY_SESSION_LEADER_SIGHUP_LIMITATION,
} from "./ProcessCaptureLifecycle.js";
import {
  PROC_READ_CONCURRENCY,
  readLinuxChildren,
  readLinuxOpenFiles,
} from "./LinuxProcessSampling.js";
import { SamplingReadBatchFailure } from "./ProcessSamplingObservation.js";
import { TerminalRenderer } from "./TerminalRenderer.js";
import { processScenarioSchema } from "../../domain/process/processScenario.js";
import type { ProcessCapture } from "../../domain/process/processCaptureParsing.js";
import type {
  FilesystemCoverage,
  ProcessCaptureTruncationDetails,
} from "../../domain/process/processCaptureCoverage.js";
import { emptyProcessCapture as emptyCapture } from "../../domain/process/processCapture.fixture.js";

const base = {
  executable: "/bin/sh",
  working_directory: "/tmp",
};

const emptyFilesystemCoverage = () =>
  emptyCapture().truncation_details.filesystem_before;

const truncationDetails = (
  frames: readonly ProcessCapture["frames"][number][],
  renderedFrames: readonly ProcessCapture["rendered_frames"][number][],
  samples: readonly ProcessCapture["process_samples"][number][],
): ProcessCaptureTruncationDetails => {
  const emptyDetails = emptyCapture().truncation_details;
  const rawBytes = frames.reduce(
    (total, frame) => total + Buffer.byteLength(frame.raw_data ?? frame.data),
    0,
  );
  const renderedBytes = renderedFrames.reduce(
    (total, frame) =>
      frame.lines.reduce(
        (sum, line) => sum + Buffer.byteLength(line),
        total + Buffer.byteLength(frame.serialized_state),
      ),
    0,
  );
  return {
    raw_terminal: {
      ...emptyDetails.raw_terminal,
      observed_bytes: rawBytes,
      retained_bytes: rawBytes,
      observed_frames: frames.length,
      retained_frames: frames.length,
    },
    rendered_terminal: {
      ...emptyDetails.rendered_terminal,
      observed_bytes: renderedBytes,
      retained_bytes: renderedBytes,
      observed_frames: renderedFrames.length,
      retained_frames: renderedFrames.length,
    },
    filesystem_before: emptyDetails.filesystem_before,
    filesystem_after: emptyDetails.filesystem_after,
    process: {
      ...emptyDetails.process,
      retained_samples: samples.length,
    },
  };
};

it("returns detached terminal observations", async () => {
  const observed: string[] = [];
  const renderer = new TerminalRenderer({
    columns: 40,
    rows: 12,
    scrollback: 100,
    maxBytes: 100_000,
    normalize: (value, maxBytes) => {
      const utf8Bytes = Buffer.byteLength(value);
      return utf8Bytes <= maxBytes
        ? { state: "normalized", value, utf8Bytes }
        : { state: "over_budget", reason: "retention" };
    },
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
    before: {
      files: [],
      truncated: false,
      completeRoots: [],
      coverage: emptyFilesystemCoverage(),
    },
    after: {
      files: [],
      truncated: false,
      completeRoots: [],
      coverage: emptyFilesystemCoverage(),
    },
    truncationDetails: truncationDetails([], renderedFrames, []),
    scenario: processScenarioSchema.parse(base),
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
    before: {
      files: [],
      truncated: false,
      completeRoots: [],
      coverage: emptyFilesystemCoverage(),
    },
    after: {
      files: [],
      truncated: false,
      completeRoots: [],
      coverage: emptyFilesystemCoverage(),
    },
    truncationDetails: truncationDetails([], [], []),
    scenario: processScenarioSchema.parse({
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
        data: "",
        sensitive: true,
        input_bytes: 6,
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
    reason: expect.stringMatching(
      /sensitive scripted input.*terminal echoes.*redacted.*terminal states.*redacted stream.*private display effects.*transformed values.*unknown/iu,
    ),
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
  ).toEqual({
    value: [201, 202, 203],
    diagnostics: { count: 0, first: null, interrupted: false },
  });
});

it("cancels filesystem snapshots before traversing declared roots", async () => {
  const controller = new AbortController();
  controller.abort();
  const failure: unknown = await snapshotRoots(
    processScenarioSchema.parse({
      ...base,
      filesystem_observation_paths: ["/tmp"],
    }),
    controller.signal,
  ).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(ProcessCaptureSnapshotFailure);
  expect(failure).toMatchObject({
    _tag: "ProcessCaptureError",
    reason: "cancelled",
    userCategory: "cancelled",
    cause: expect.objectContaining({ name: "AbortError" }),
    snapshot: {
      files: [],
      truncated: true,
      completeRoots: [],
      coverage: {
        hashed_bytes: 0,
        enumeration_omissions: [],
        hash_omissions: [],
      },
    },
    cleanupLeases: [],
    readFailures: [],
  });
  expect(failure instanceof Error ? failure.cause : undefined).toBe(
    controller.signal.reason,
  );
});

it.each(["symlink_not_followed", "observer_owned"] as const)(
  "projects %s subtree coverage into Evidence limitations and residual unknowns",
  (reason) => {
    const capture = emptyCapture();
    const build = (coverage: FilesystemCoverage) => {
      const snapshot = {
        files: [],
        truncated: false,
        completeRoots: ["root_0"],
        coverage,
      };
      return buildCaptureResult({
        frames: [],
        exit: { exitCode: 0, reason: "exited" },
        samples: [],
        before: snapshot,
        after: snapshot,
        truncationDetails: {
          ...truncationDetails([], [], []),
          filesystem_before: coverage,
          filesystem_after: coverage,
        },
        scenario: processScenarioSchema.parse({
          ...base,
          filesystem_observation_paths: ["/selected"],
        }),
        rootPid: 1,
        samplingPartial: false,
        renderedFrames: [],
        interactions: [],
        checkpoints: capture.filesystem_checkpoints,
        settlement: {
          state: capture.settlement.state,
          elapsed_ms: capture.settlement.elapsed_ms,
        },
        manifest: capture.manifest,
        eventJournal: [],
      });
    };
    const complete = { ...emptyFilesystemCoverage(), unobserved_subtrees: [] };
    expect(
      build(complete).residual_unknowns.filter(
        ({ scope }) => scope === "filesystem",
      ),
    ).toEqual([]);
    const result = build({
      ...complete,
      unobserved_subtrees: [{ path: "root_0:.", reason }],
    });
    const unknowns = result.residual_unknowns.filter(
      ({ scope }) => scope === "filesystem",
    );
    expect(unknowns).toHaveLength(2);
    for (const unknown of unknowns) {
      expect(unknown.reason).toContain("root_0:.");
      expect(unknown.reason).toContain(
        reason === "symlink_not_followed"
          ? "symbolic links are not followed"
          : "exact observer-owned directory",
      );
      expect(result.limitations).toContain(unknown.reason);
    }
    expect(result.truncated).toBe(false);
  },
);

it("records the PTY session-leader SIGHUP limitation on POSIX captures only", () => {
  const capture = emptyCapture();
  const buildForPlatform = (platform: string) =>
    buildCaptureResult({
      frames: [],
      exit: { exitCode: 0, reason: "exited" },
      samples: [],
      before: {
        files: [],
        truncated: false,
        completeRoots: [],
        coverage: emptyFilesystemCoverage(),
      },
      after: {
        files: [],
        truncated: false,
        completeRoots: [],
        coverage: emptyFilesystemCoverage(),
      },
      truncationDetails: truncationDetails([], [], []),
      scenario: processScenarioSchema.parse(base),
      rootPid: 1,
      samplingPartial: false,
      renderedFrames: [],
      interactions: [],
      checkpoints: capture.filesystem_checkpoints,
      settlement: {
        state: capture.settlement.state,
        elapsed_ms: capture.settlement.elapsed_ms,
      },
      manifest: { ...capture.manifest, platform },
      eventJournal: [],
    });

  expect(POSIX_PTY_SESSION_LEADER_SIGHUP_LIMITATION).toMatch(
    /PTY session leader/iu,
  );
  expect(POSIX_PTY_SESSION_LEADER_SIGHUP_LIMITATION).toMatch(/SIGHUP/u);
  expect(POSIX_PTY_SESSION_LEADER_SIGHUP_LIMITATION).toMatch(/group/iu);
  for (const posixPlatform of ["linux", "darwin"]) {
    expect(buildForPlatform(posixPlatform).limitations).toContain(
      POSIX_PTY_SESSION_LEADER_SIGHUP_LIMITATION,
    );
  }
  const winLimitations = buildForPlatform("win32").limitations;
  expect(winLimitations).not.toContain(
    POSIX_PTY_SESSION_LEADER_SIGHUP_LIMITATION,
  );
  expect(winLimitations.some((line) => line.includes("SIGHUP"))).toBe(false);
});

describe("readLinuxOpenFiles", () => {
  it("bounds descriptor readlink concurrency to PROC_READ_CONCURRENCY while preserving descriptor order", async () => {
    const total = PROC_READ_CONCURRENCY * 2 + 7;
    const descriptors = Array.from({ length: total }, (_, index) =>
      String(index),
    );
    let active = 0;
    let maxActive = 0;
    const observation = await readLinuxOpenFiles(
      100,
      new AbortController().signal,
      {
        descriptors: () => Promise.resolve(descriptors),
        readlink: async (_pid, descriptor) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            const index = Number(descriptor);
            // Resolve even descriptors slower than odd ones to verify order preservation.
            await new Promise((resolve) =>
              setTimeout(resolve, index % 2 === 0 ? 4 : 1),
            );
            if (index === 1) return "socket:[1234]";
            if (index === 2) return "/tmp/removed.log (deleted)";
            return `/var/log/fd-${descriptor}`;
          } finally {
            active -= 1;
          }
        },
      },
    );
    expect(maxActive).toBe(PROC_READ_CONCURRENCY);
    expect(observation.diagnostics).toEqual({
      count: 0,
      first: null,
      interrupted: false,
    });
    expect(observation.value).toHaveLength(total - 1);
    expect(observation.value.slice(0, 4)).toEqual([
      "/var/log/fd-0",
      "/tmp/removed.log",
      "/var/log/fd-3",
      "/var/log/fd-4",
    ]);
    expect(observation.value.at(-1)).toBe(`/var/log/fd-${String(total - 1)}`);
  });

  it("ignores expected fd-close races and retains permission/I/O failures in descriptor order", async () => {
    const descriptors = ["1", "2", "3", "4", "5"];
    const observation = await readLinuxOpenFiles(
      100,
      new AbortController().signal,
      {
        descriptors: () => Promise.resolve(descriptors),
        readlink: async (_pid, descriptor) => {
          if (descriptor === "1")
            throw Object.assign(new Error("closed"), { code: "ENOENT" });
          if (descriptor === "2") {
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          }
          if (descriptor === "3")
            throw Object.assign(new Error("io error"), { code: "EIO" });
          if (descriptor === "4")
            throw Object.assign(new Error("exited"), { code: "ESRCH" });
          return "/app/data.db";
        },
      },
    );
    expect(observation.value).toEqual(["/app/data.db"]);
    expect(observation.diagnostics).toMatchObject({
      count: 2,
      interrupted: false,
    });
    expect(observation.diagnostics.first).toContain("/proc/100/fd/2: EACCES");
  });

  it("stops remaining batches on abort while settling all issued batch reads", async () => {
    const total = PROC_READ_CONCURRENCY + 5;
    const descriptors = Array.from({ length: total }, (_, index) =>
      String(index),
    );
    const controller = new AbortController();
    const seen: string[] = [];
    let settledInFirstBatch = 0;
    const observation = await readLinuxOpenFiles(100, controller.signal, {
      descriptors: () => Promise.resolve(descriptors),
      readlink: async (_pid, descriptor) => {
        seen.push(descriptor);
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (descriptor === "0") controller.abort({ reason: "stop" });
        settledInFirstBatch += 1;
        return `/tmp/file-${descriptor}`;
      },
    });
    expect(seen).toHaveLength(PROC_READ_CONCURRENCY);
    expect(settledInFirstBatch).toBe(PROC_READ_CONCURRENCY);
    expect(observation.value).toHaveLength(PROC_READ_CONCURRENCY);
    expect(observation.diagnostics.interrupted).toBe(true);
  });

  it("settles the active batch before propagating an inspection cleanup failure", async () => {
    const file = await failedInspectionDescriptor();
    let peerSettled = false;
    try {
      const failure = await readLinuxOpenFiles(
        100,
        new AbortController().signal,
        {
          descriptors: () => Promise.resolve(["0", "1"]),
          readlink: async (_pid, descriptor) => {
            if (descriptor === "0") throw file.failure;
            await new Promise((resolve) => setTimeout(resolve, 5));
            peerSettled = true;
            return "/tmp/ok";
          },
        },
      ).catch((cause: unknown) => cause);
      expect(peerSettled).toBe(true);
      expect(failure).toBeInstanceOf(SamplingReadBatchFailure);
      expect((failure as SamplingReadBatchFailure).inspectionFailures).toEqual([
        file.failure,
      ]);
    } finally {
      file.allow();
      await file.failure.owner.close();
    }
  });
});
