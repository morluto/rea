import { execFile } from "node:child_process";
import { rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { itWithCaptureCapability } from "./processCaptureCapability.js";

import {
  captureProcessScenario,
  ProcessCaptureError,
} from "../../../src/application/ProcessHarness.js";
import { parseProcessScenario } from "../../../src/domain/processCapture.js";

const processFixture = fileURLToPath(
  new URL("../../fixtures/processFidelity.mjs", import.meta.url),
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

// Each action is triggered by observed terminal output rather than a wall-clock
// offset. A fixed `at_ms` can fire before the child has written its prompt under
// host contention, which drops the input and the resize echo and made this test
// load-flaky.
//
// This also covers the reactive `resize` path against time bucketing: rendered
// frames must share the normalized clock used by captured frames. They did not,
// so the capture failed validation with "rendered_frames: timestamps must be
// ordered" until the renderer call in ProcessReactiveEffects was normalized.
itWithCaptureCapability(
  "captures source-owned interactive, resize, Unicode, and signal behavior",
  async () => {
    const result = await captureProcessScenario(
      parseProcessScenario({
        executable: process.execPath,
        arguments: [processFixture, "interactive"],
        working_directory: dirname(processFixture),
        normalization: { time_bucket_ms: 10 },
        timeout_ms: 20_000,
        idle_timeout_ms: 10_000,
        reactive: {
          initial_state: "awaiting_prompt",
          deadline_ms: 15_000,
          states: [
            {
              id: "awaiting_prompt",
              max_visits: 1,
              deadline_ms: 10_000,
              on: [
                {
                  id: "answer",
                  priority: 0,
                  max_uses: 1,
                  when: {
                    kind: "terminal_text",
                    literal: "prompt>",
                    occurrence: 1,
                    since: { kind: "scenario_start" },
                    consume: true,
                  },
                  actions: [
                    { type: "send_input", data: "answer", sensitive: false },
                  ],
                  target: { kind: "goto", state: "awaiting_resize" },
                },
              ],
            },
            {
              id: "awaiting_resize",
              max_visits: 1,
              deadline_ms: 10_000,
              on: [
                {
                  id: "resize",
                  priority: 0,
                  max_uses: 1,
                  when: {
                    kind: "terminal_text",
                    literal: "input:answer",
                    occurrence: 1,
                    since: { kind: "scenario_start" },
                    consume: true,
                  },
                  actions: [{ type: "resize", columns: 100, rows: 40 }],
                  target: { kind: "goto", state: "awaiting_signal" },
                },
              ],
            },
            {
              id: "awaiting_signal",
              max_visits: 1,
              deadline_ms: 10_000,
              on: [
                {
                  id: "signal",
                  priority: 0,
                  max_uses: 1,
                  when: {
                    kind: "terminal_text",
                    literal: "resize:100x40",
                    occurrence: 1,
                    since: { kind: "scenario_start" },
                    consume: true,
                  },
                  actions: [
                    {
                      type: "send_signal",
                      target: { kind: "root" },
                      signal: "SIGINT",
                    },
                  ],
                  target: { kind: "finish" },
                },
              ],
            },
          ],
        },
      }),
    );
    if (!result.ok) throw result.error;
    expect(result.ok).toBe(true);
    const output = result.value.frames.map(({ data }) => data).join("");
    expect(output).toContain("prompt>");
    expect(output).toContain("input:answer unicode:雪");
    expect(output).toContain("resize:100x40");
    expect(output).toContain("signal:SIGINT");
    const resized = result.value.rendered_frames.find(
      ({ columns, rows }) => columns === 100 && rows === 40,
    );
    expect(resized).toBeDefined();
    expect(resized?.lines.join("\n")).toContain("input:answer unicode:雪");
    expect(result.value.exit.code).toBe(0);
  },
);

itWithCaptureCapability(
  "dispatches scheduled events before a silent PTY produces output",
  async () => {
    const result = await captureProcessScenario(
      parseProcessScenario({
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
        timeout_ms: 2_000,
        idle_timeout_ms: 2_000,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
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
