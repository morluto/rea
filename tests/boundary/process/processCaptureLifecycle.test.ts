import { execFile } from "node:child_process";
import { rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { itWithCaptureCapability } from "./processCaptureCapability.js";

import { captureProcessScenario } from "../../../src/application/ProcessHarness.js";
import { snapshotRoots } from "../../../src/application/FilesystemSnapshot.js";
import { parseProcessScenario } from "../../../src/domain/processCapture.js";

const processFixture = fileURLToPath(
  new URL("../../fixtures/processFidelity.mjs", import.meta.url),
);
const snapshotCancellationFixture = fileURLToPath(
  new URL("../../fixtures/processSnapshotCancellation.mjs", import.meta.url),
);
const execFileAsync = promisify(execFile);

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
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      const escaped = result.value.files_after.find((file) =>
        file.path.endsWith(":escape"),
      );
      expect(escaped?.symlink_target).toBe("/etc/passwd");
      expect(result.value.truncated).toBe(false);
      expect(JSON.stringify(result.value.files_after)).not.toContain(root);
      expect(
        result.value.files_after.some((file) => file.path.includes("passwd")),
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
    if (!result.ok) throw result.error;
    expect(result.ok).toBe(true);
    const output = result.value.frames.map(({ data }) => data).join("");
    expect(output).toContain("prompt>");
    expect(output).toContain("input:answer unicode:雪");
    expect(output).toContain("resize:100x40");
    expect(result.value.interaction_events).toMatchObject([
      { type: "resize", outcome: "dispatched", scheduled_at_ms: 0 },
      { type: "input", outcome: "dispatched", scheduled_at_ms: 0 },
    ]);
    const resized = result.value.rendered_frames.find(
      ({ columns, rows, lines }) =>
        columns === 100 &&
        rows === 40 &&
        lines.join("\n").includes("input:answer unicode:雪"),
    );
    expect(resized).toBeDefined();
    expect(resized?.lines.join("\n")).toContain("input:answer unicode:雪");
    expect(result.value.exit.code).toBe(0);
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
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.interaction_events).toMatchObject([
      { type: "signal", data: "SIGTERM", outcome: "dispatched" },
    ]);
    expect(result.value.exit).toMatchObject({ signal: 15, reason: "exited" });
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
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.frames.map(({ data }) => data).join("")).toContain(
      "input:answer",
    );
    expect(result.value.interaction_events).toMatchObject([
      { type: "resize", scheduled_at_ms: 25, outcome: "dispatched" },
      { type: "input", scheduled_at_ms: 50, outcome: "dispatched" },
    ]);
    expect(
      result.value.interaction_events.every(
        ({ scheduled_at_ms, dispatched_at_ms }) =>
          dispatched_at_ms >= scheduled_at_ms,
      ),
    ).toBe(true);
    expect(
      result.value.frames.find(({ data }) => data.includes("input:answer"))
        ?.at_ms,
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
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.exit).toMatchObject({ code: 0, reason: "exited" });
    expect(result.value.frames.map(({ data }) => data).join("")).toContain(
      "tree-ready",
    );
    const commands = result.value.process_samples.map(({ command }) => command);
    expect(commands.some((command) => command.includes("tree-child"))).toBe(
      true,
    );
    expect(commands.some((command) => command.includes("forks.js"))).toBe(
      false,
    );
    expect(
      commands.some((command) => command.includes("tree-grandchild")),
    ).toBe(true);
    expect(JSON.stringify(result.value.process_samples)).toContain(
      dirname(processFixture),
    );
    const { stdout } = await execFileAsync("ps", ["-axo", "command="]);
    expect(stdout).not.toContain(`${processFixture} tree-child`);
    expect(stdout).not.toContain(`${processFixture} tree-grandchild`);
  },
  20_000,
);
