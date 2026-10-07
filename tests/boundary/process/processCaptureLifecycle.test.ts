import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { itWithCaptureCapability } from "./processCaptureCapability.js";

import { captureProcessScenario } from "../../../src/process/capture/ProcessHarness.js";
import { snapshotRoots } from "../../../src/process/capture/FilesystemSnapshot.js";
import { ProcessCaptureError } from "../../../src/process/capture/ProcessCaptureError.js";
import {
  type ProcessCaptureCleanupHost,
  observeLaunchedExecutable,
  observeSelectedExecutable,
} from "../../../src/process/capture/ProcessCaptureLifecycle.js";
import {
  parseProcessScenario,
  type ProcessCapture,
} from "../../../src/domain/process/processCapture.js";

const processFixture = fileURLToPath(
  new URL("../../fixtures/processFidelity.mjs", import.meta.url),
);
const snapshotCancellationFixture = fileURLToPath(
  new URL("../../fixtures/processSnapshotCancellation.mjs", import.meta.url),
);
const execFileAsync = promisify(execFile);

type CaptureRun = Awaited<ReturnType<typeof captureProcessScenario>>;
type PartialCapture = Extract<
  NonNullable<ProcessCaptureError["partialObservation"]>,
  { readonly capture: unknown }
>["capture"];
const captureObservations = (
  result: CaptureRun,
): {
  readonly capture: ProcessCapture | PartialCapture;
  readonly cleanupIncomplete: boolean;
} => {
  if (result.ok) return { capture: result.value, cleanupIncomplete: false };
  if (!(result.error instanceof ProcessCaptureError)) throw result.error;
  const report = result.error.cleanupReport;
  const partial = result.error.partialObservation;
  expect(result.error.reason).toBe("cleanup_incomplete");
  expect(report?.owned_process_group.state).toBe("unverified");
  expect(report?.owned_process_group.reason).toMatch(
    /environment_unavailable=[1-9][0-9]*/u,
  );
  expect(report?.terminal_renderer.state).toBe("cleaned");
  expect(report?.temporary_root.state).toBe("cleaned");
  if (partial === undefined || !("capture" in partial))
    throw new Error(
      "cleanup-incomplete capture omitted completed observations",
    );
  const capture = partial.capture;
  expect(capture.settlement.cleanup_outcome).toBe("failed");
  return { capture, cleanupIncomplete: true };
};

const processState = async (pid: number): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync("ps", [
      "-o",
      "stat=",
      "-p",
      String(pid),
    ]);
    return stdout.trim() || undefined;
  } catch (cause: unknown) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      cause.code === 1 &&
      "stdout" in cause &&
      cause.stdout === ""
    )
      return undefined;
    throw cause;
  }
};

const waitForProcessExit = async (pid: number): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const state = await processState(pid);
    if (state === undefined || state.startsWith("Z")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Process ${String(pid)} did not exit within the test bound`);
};

const readDetachedFixturePids = async (marker: string): Promise<number[]> => {
  let contents: string;
  try {
    contents = await readFile(marker, "utf8");
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return [];
    throw cause;
  }
  const parsed: unknown = JSON.parse(contents);
  if (typeof parsed !== "object" || parsed === null) return [];
  const candidatePids = [
    "ownedPid" in parsed ? parsed.ownedPid : undefined,
    "unownedPid" in parsed ? parsed.unownedPid : undefined,
  ];
  return candidatePids.flatMap((pid) =>
    typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1
      ? [pid]
      : [],
  );
};

const terminateFixtureProcess = async (pid: number): Promise<void> => {
  try {
    process.kill(pid, "SIGKILL");
  } catch (cause: unknown) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH"))
      throw cause;
  }
  await waitForProcessExit(pid);
};

itWithCaptureCapability(
  "cleans detached run-token children omitted by sampling and preserves an unowned neighbor",
  async () => {
    const root = await createTestTempDirectory("rea-detached-cleanup-");
    const pidMarker = join(root, "children.json");
    let ownedPid: number | undefined;
    let unownedPid: number | undefined;
    try {
      const result = await captureProcessScenario(
        parseProcessScenario({
          executable: process.execPath,
          arguments: [processFixture, "detached-cleanup", pidMarker],
          working_directory: root,
          settle_ms: 0,
          timeout_ms: 5_000,
          idle_timeout_ms: 5_000,
          limits: { processes: 1 },
        }),
      );
      const { capture, cleanupIncomplete } = captureObservations(result);
      const parsed: unknown = JSON.parse(await readFile(pidMarker, "utf8"));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("ownedPid" in parsed) ||
        typeof parsed.ownedPid !== "number" ||
        !("unownedPid" in parsed) ||
        typeof parsed.unownedPid !== "number"
      )
        throw new TypeError("detached-child fixture wrote invalid PIDs");
      // Register fixture children before assertions so teardown can clean them
      // even when a later expectation fails.
      ownedPid = parsed.ownedPid;
      unownedPid = parsed.unownedPid;
      expect(capture.process_samples.some(({ pid }) => pid === ownedPid)).toBe(
        false,
      );
      if (cleanupIncomplete)
        expect(capture.settlement.cleanup_outcome).toBe("failed");
      else
        expect(result.ok && result.value.cleanup.owned_process_group).toBe(
          "verified",
        );
      await waitForProcessExit(ownedPid);
      const unownedState = await processState(unownedPid);
      expect(unownedState).toBeDefined();
      expect(unownedState?.startsWith("Z")).toBe(false);
    } finally {
      try {
        let fixturePids: number[] = [];
        let teardownFailure: unknown;
        try {
          fixturePids = await readDetachedFixturePids(pidMarker);
        } catch (cause: unknown) {
          teardownFailure = cause;
        }
        for (const pid of new Set([
          ...fixturePids,
          ...(ownedPid === undefined ? [] : [ownedPid]),
          ...(unownedPid === undefined ? [] : [unownedPid]),
        ])) {
          try {
            await terminateFixtureProcess(pid);
          } catch (cause: unknown) {
            teardownFailure ??= cause;
          }
        }
        if (teardownFailure !== undefined) throw teardownFailure;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  10_000,
);

itWithCaptureCapability(
  "retains collected observations when completion and cleanup both fail",
  async () => {
    let snapshotCalls = 0;
    const captureSnapshot: typeof snapshotRoots = async () => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) return { files: [], truncated: false };
      throw new Error("fixture final snapshot failure");
    };
    const cleanupHost: ProcessCaptureCleanupHost = {
      platform: process.platform,
      cleanupProcessGroup: async () => ({
        cleaned: false,
        reason: "fixture cleanup could not be verified",
      }),
      verifyTokenOwnedProcesses: async () => ({
        cleaned: false,
        reason: "fixture cleanup could not be verified",
      }),
      removeTemporaryRoot: async (path) =>
        rm(path, { recursive: true, force: true }),
    };
    const result = await captureProcessScenario(
      parseProcessScenario({
        executable: process.execPath,
        arguments: [processFixture, "partial"],
        working_directory: dirname(processFixture),
        settle_ms: 0,
        timeout_ms: 5_000,
        idle_timeout_ms: 5_000,
      }),
      undefined,
      process.platform,
      process.env,
      captureSnapshot,
      cleanupHost,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected cleanup-incomplete failure");
    if (!(result.error instanceof ProcessCaptureError)) throw result.error;
    const partial = result.error.partialObservation;
    expect(result.error.reason).toBe("cleanup_incomplete");
    expect(result.error.executionFailure).toBe(
      "fixture final snapshot failure",
    );
    expect(partial).toBeDefined();
    if (partial === undefined || !("observations" in partial))
      throw new Error("expected incomplete process observations");
    const observations = partial.observations;
    expect(observations.frames.state).toBe("available");
    if (observations.frames.state !== "available")
      throw new Error("expected terminal output observations");
    expect(
      observations.frames.value.map(({ data }) => data).join(""),
    ).toContain("partial-frame");
    expect(observations.rendered_frames.state).toBe("available");
    if (observations.rendered_frames.state !== "available")
      throw new Error("expected rendered terminal observations");
    expect(observations.rendered_frames.value.length).toBeGreaterThan(0);
    expect(observations.interaction_events.state).toBe("available");
    expect(observations.exit).toMatchObject({
      state: "available",
      value: { reason: "exited" },
    });
    expect(observations.settlement.state).toBe("available");
    expect(observations.process_samples.state).toBe("available");
    expect(observations.target_pid).toEqual({ state: "available", value: 1 });
    expect(observations.filesystem_snapshots.before.state).toBe("available");
    if (observations.filesystem_snapshots.before.state !== "available")
      throw new Error("expected initial filesystem snapshot");
    expect(observations.filesystem_snapshots.before.value.truncated).toBe(
      false,
    );
    expect(observations.filesystem_snapshots.after).toEqual({
      state: "unavailable",
      reason:
        "Final filesystem snapshot failed: fixture final snapshot failure",
    });
    expect(observations.event_journal.state).toBe("available");
    if (observations.event_journal.state !== "available")
      throw new Error("expected capture event journal");
    expect(
      observations.event_journal.value.some(
        ({ collection }) => collection === "lifecycle",
      ),
    ).toBe(true);
    expect(observations.manifest.state).toBe("unavailable");
    expect(snapshotCalls).toBe(2);
  },
  10_000,
);

itWithCaptureCapability(
  "keeps selected executable evidence separate when the path identity changes before validation",
  async () => {
    const root = await createTestTempDirectory("rea-executable-replaced-");
    const executable = join(root, "selected-executable");
    await symlink(process.execPath, executable);
    try {
      const selected = await observeSelectedExecutable(executable);
      expect(selected.sha256).toMatch(/^[a-f0-9]{64}$/u);
      await rm(executable);
      await symlink("/bin/sh", executable);
      expect(observeLaunchedExecutable(executable, selected)).toEqual({
        selectedSha256: selected.sha256,
        sha256: null,
        state: "unknown",
        reason: "Executable path metadata changed between sampling and spawn.",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

itWithCaptureCapability(
  "keeps the prelaunch executable sample when the selected path is replaced during capture",
  async () => {
    const root = await createTestTempDirectory("rea-executable-identity-");
    const executable = join(root, "selected-executable");
    const readyMarker = join(root, "child-ready");
    await symlink(process.execPath, executable);
    const launchedDigest = createHash("sha256")
      .update(await readFile(process.execPath))
      .digest("hex");
    try {
      const capturePromise = captureProcessScenario(
        parseProcessScenario({
          executable,
          arguments: [processFixture, "ready-hang", readyMarker],
          working_directory: root,
          timeout_ms: 1_500,
          idle_timeout_ms: 5_000,
        }),
      );
      const deadline = Date.now() + 2_000;
      let ready = false;
      while (!ready && Date.now() < deadline) {
        try {
          await access(readyMarker);
          ready = true;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(ready).toBe(true);
      await rm(executable);
      await symlink("/bin/sh", executable);
      const result = await capturePromise;
      const { capture } = captureObservations(result);
      expect(capture.manifest).toMatchObject({
        selected_executable_sha256: launchedDigest,
        executable_sha256: launchedDigest,
        executable_identity: {
          state: "path_metadata_unchanged",
          reason: null,
        },
      });
      expect(capture.exit.reason).toBe("timeout");
      expect(capture.limitations).toContain(
        "The executable digest is a prelaunch file sample; matching path metadata immediately after spawn does not prove an atomic operating-system image binding.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000,
);

itWithCaptureCapability(
  "records external symlink metadata without following the target",
  async () => {
    const root = await createTestTempDirectory("rea-symlink-test-");
    await symlink("/etc/passwd", join(root, "escape"));
    try {
      const result = await captureProcessScenario(
        parseProcessScenario({
          executable: "/usr/bin/true",
          working_directory: root,
          filesystem_observation_paths: [root],
        }),
      );
      const { capture } = captureObservations(result);
      const escaped = capture.files_after.find((file) =>
        file.path.endsWith(":escape"),
      );
      expect(escaped?.symlink_target).toBe("/etc/passwd");
      expect(capture.truncated).toBe(false);
      expect(JSON.stringify(capture.files_after)).not.toContain(root);
      expect(
        capture.files_after.some((file) => file.path.includes("passwd")),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

itWithCaptureCapability(
  "distinguishes timeout from cancellation and cleans both runs",
  async () => {
    const timedOut = await captureProcessScenario(
      parseProcessScenario({
        executable: process.execPath,
        arguments: [processFixture, "hang"],
        working_directory: dirname(processFixture),
        timeout_ms: 50,
        idle_timeout_ms: 5_000,
      }),
    );
    const timedOutCapture = captureObservations(timedOut);
    expect(timedOutCapture.capture.exit.reason).toBe("timeout");
    if (!timedOutCapture.cleanupIncomplete && timedOut.ok)
      expect(timedOut.value.cleanup).toEqual({
        owned_process_group: "verified",
        temporary_root: "removed",
      });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const cancelled = await captureProcessScenario(
      parseProcessScenario({
        executable: process.execPath,
        arguments: [processFixture, "hang"],
        working_directory: dirname(processFixture),
        timeout_ms: 5_000,
        idle_timeout_ms: 5_000,
      }),
      controller.signal,
    );
    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) throw new Error("expected cancellation");
    expect(cancelled.error.message).toContain("cancelled");
  },
);

itWithCaptureCapability(
  "classifies cancellation raised by the initial filesystem snapshot",
  async () => {
    const root = await createTestTempDirectory("rea-snapshot-initial-cancel-");
    const path = join(root, "input");
    await writeFile(path, "observed\n");
    const controller = new AbortController();
    const { signal } = controller;
    const throwIfAborted = signal.throwIfAborted.bind(signal);
    Object.defineProperty(signal, "throwIfAborted", {
      value: () => {
        controller.abort();
        throwIfAborted();
      },
    });

    const result = await captureProcessScenario(
      parseProcessScenario({
        executable: process.execPath,
        working_directory: root,
        filesystem_observation_paths: [path],
      }),
      signal,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected initial snapshot cancellation");
    expect(result.error).toMatchObject({
      reason: "cancelled",
      userCategory: "cancelled",
    });
  },
);

itWithCaptureCapability(
  "classifies cancellation raised by the final filesystem snapshot",
  async () => {
    const root = await createTestTempDirectory("rea-snapshot-final-cancel-");
    const controller = new AbortController();
    let initialSnapshotCompleted = false;
    const captureSnapshot: typeof snapshotRoots = async (scenario, signal) => {
      if (initialSnapshotCompleted) controller.abort();
      const snapshot = await snapshotRoots(scenario, signal);
      initialSnapshotCompleted = true;
      return snapshot;
    };
    const resultPromise = captureProcessScenario(
      parseProcessScenario({
        executable: process.execPath,
        arguments: [snapshotCancellationFixture, root],
        working_directory: dirname(snapshotCancellationFixture),
        filesystem_observation_paths: [root],
        settle_ms: 0,
      }),
      controller.signal,
      process.platform,
      process.env,
      captureSnapshot,
    );

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected final snapshot cancellation");
    expect(initialSnapshotCompleted).toBe(true);
    expect(result.error).toMatchObject({
      reason: "cancelled",
      userCategory: "cancelled",
    });
  },
);

itWithCaptureCapability(
  "preserves filesystem errors that are not caller cancellation",
  async () => {
    const root = await createTestTempDirectory("rea-snapshot-io-error-");
    const obstruction = join(root, "not-a-directory");
    await writeFile(obstruction, "file");
    const controller = new AbortController();
    const captureSnapshot: typeof snapshotRoots = async (scenario, signal) => {
      try {
        return await snapshotRoots(scenario, signal);
      } catch (cause: unknown) {
        controller.abort();
        throw cause;
      }
    };

    const result = await captureProcessScenario(
      parseProcessScenario({
        executable: process.execPath,
        working_directory: root,
        filesystem_observation_paths: [join(obstruction, "child")],
      }),
      controller.signal,
      process.platform,
      process.env,
      captureSnapshot,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected filesystem observation failure");
    expect(result.error).toMatchObject({
      reason: "capture_failed",
      cause: { code: "ENOTDIR" },
    });
  },
);

itWithCaptureCapability(
  "captures input, Unicode, and resize across PTY startup",
  async () => {
    const result = await captureProcessScenario(
      parseProcessScenario({
        executable: process.execPath,
        arguments: [processFixture, "interactive"],
        working_directory: dirname(processFixture),
        events: [
          { type: "resize", at_ms: 0, columns: 100, rows: 40 },
          { type: "input", at_ms: 0, data: "answer\n" },
        ],
        normalization: { time_bucket_ms: 10 },
        timeout_ms: 20_000,
        idle_timeout_ms: 10_000,
      }),
    );
    const { capture } = captureObservations(result);
    const output = capture.frames.map(({ data }) => data).join("");
    expect(output).toContain("prompt>");
    expect(output).toContain("input:answer unicode:雪");
    expect(output).toContain("resize:100x40");
    expect(capture.interaction_events).toMatchObject([
      { type: "resize", outcome: "dispatched", scheduled_at_ms: 0 },
      { type: "input", outcome: "dispatched", scheduled_at_ms: 0 },
    ]);
    const resized = capture.rendered_frames.find(
      ({ columns, rows, lines }) =>
        columns === 100 &&
        rows === 40 &&
        lines.join("\n").includes("input:answer unicode:雪"),
    );
    expect(resized).toBeDefined();
    expect(resized?.lines.join("\n")).toContain("input:answer unicode:雪");
    expect(capture.exit.code).toBe(0);
  },
);

itWithCaptureCapability(
  "dispatches an external signal without depending on child startup output",
  async () => {
    const result = await captureProcessScenario(
      parseProcessScenario({
        executable: process.execPath,
        arguments: [processFixture, "hang"],
        working_directory: dirname(processFixture),
        events: [{ type: "signal", at_ms: 0, signal: "SIGTERM" }],
        timeout_ms: 2_000,
        idle_timeout_ms: 2_000,
      }),
    );
    const { capture } = captureObservations(result);
    expect(capture.interaction_events).toMatchObject([
      { type: "signal", data: "SIGTERM", outcome: "dispatched" },
    ]);
    expect(capture.exit).toMatchObject({ signal: 15, reason: "exited" });
  },
);

itWithCaptureCapability(
  "buffers newline input until a silent PTY fixture is ready to read it",
  async () => {
    const result = await captureProcessScenario(
      parseProcessScenario({
        executable: process.execPath,
        arguments: [processFixture, "silent-interactive"],
        working_directory: dirname(processFixture),
        events: [
          { type: "resize", at_ms: 25, columns: 100, rows: 40 },
          { type: "input", at_ms: 50, data: "answer\n" },
        ],
        timeout_ms: 20_000,
        idle_timeout_ms: 20_000,
      }),
    );
    const { capture } = captureObservations(result);
    expect(capture.frames.map(({ data }) => data).join("")).toContain(
      "input:answer",
    );
    expect(capture.interaction_events).toMatchObject([
      { type: "resize", scheduled_at_ms: 25, outcome: "dispatched" },
      { type: "input", scheduled_at_ms: 50, outcome: "dispatched" },
    ]);
    expect(
      capture.interaction_events.every(
        ({ scheduled_at_ms, dispatched_at_ms }) =>
          dispatched_at_ms >= scheduled_at_ms,
      ),
    ).toBe(true);
    expect(
      capture.frames.find(({ data }) => data.includes("input:answer"))?.at_ms,
    ).toBeGreaterThanOrEqual(50);
  },
);

itWithCaptureCapability(
  "samples and cleans a source-owned child and grandchild process tree",
  async () => {
    const result = await captureProcessScenario(
      parseProcessScenario({
        executable: process.execPath,
        arguments: [processFixture, "tree"],
        working_directory: dirname(processFixture),
        timeout_ms: 20_000,
        idle_timeout_ms: 20_000,
      }),
    );
    const { capture } = captureObservations(result);
    expect(capture.exit).toMatchObject({ code: 0, reason: "exited" });
    expect(capture.frames.map(({ data }) => data).join("")).toContain(
      "tree-ready",
    );
    const commands = capture.process_samples.map(({ command }) => command);
    expect(commands.some((command) => command.includes("tree-child"))).toBe(
      true,
    );
    expect(commands.some((command) => command.includes("forks.js"))).toBe(
      false,
    );
    expect(
      commands.some((command) => command.includes("tree-grandchild")),
    ).toBe(true);
    expect(JSON.stringify(capture.process_samples)).toContain(
      dirname(processFixture),
    );
    const { stdout } = await execFileAsync("ps", ["-axo", "command="]);
    expect(stdout).not.toContain(`${processFixture} tree-child`);
    expect(stdout).not.toContain(`${processFixture} tree-grandchild`);
  },
  20_000,
);
