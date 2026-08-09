import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  captureProcessScenario,
  probeProcessCaptureCapability,
} from "../../../src/application/ProcessHarness.js";
import { parseProcessScenario } from "../../../src/domain/processCapture.js";

const buildTerminalScenario = (root: string, script: string) =>
  parseProcessScenario({
    approved: true,
    executable: process.execPath,
    arguments: [script],
    working_directory: root,
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
            outputs: [{ at_ms: 0, stream: "stdout", data: "codex 1.2.3\n" }],
            termination: { type: "exit", code: 0 },
          },
        ],
      },
      {
        name: "node",
        routes: [
          {
            arguments: ["--version"],
            outputs: [{ at_ms: 0, stream: "stdout", data: "node 9.8.7\n" }],
            termination: { type: "exit", code: 0 },
          },
        ],
      },
    ],
    reactive: {
      version: 1,
      initial_state: "waiting_for_shim",
      deadline_ms: 5_000,
      states: [
        {
          id: "waiting_for_shim",
          max_visits: 1,
          deadline_ms: 2_000,
          on: [
            {
              id: "record_shim",
              priority: 0,
              max_uses: 1,
              when: {
                kind: "event",
                source: "shim",
                exact: {
                  command: "codex",
                  route_index: 0,
                  arguments: ["--version"],
                  working_directory: "<working-directory>",
                  outcome: "matched",
                },
                ignore_fields: ["sequence", "at_ms"],
                since: { kind: "scenario_start" },
                consume: true,
                cardinality: { min: 1, max: 1 },
              },
              actions: [{ type: "checkpoint", name: "reactive_shim_seen" }],
              target: {
                kind: "goto",
                state: "waiting_for_checkpoint",
              },
            },
          ],
        },
        {
          id: "waiting_for_checkpoint",
          max_visits: 1,
          deadline_ms: 2_000,
          on: [
            {
              id: "finish_checkpoint",
              priority: 0,
              max_uses: 1,
              when: {
                kind: "event",
                source: "filesystem",
                exact: {
                  name: "reactive_shim_seen",
                  files: [],
                  effects: [],
                  truncated: false,
                },
                ignore_fields: ["at_ms"],
                since: { kind: "scenario_start" },
                consume: true,
                cardinality: { min: 1, max: 1 },
              },
              actions: [],
              target: { kind: "finish", outcome: "passed" },
            },
          ],
        },
      ],
    },
  });

// The assertions share one captured process and therefore one cleanup scope.
it("renders terminal state, records shim invocations, and captures literal checkpoints", async () => {
  const root = await createTestTempDirectory("rea-v3-test-");
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
      buildTerminalScenario(root, script),
      {
        status: "enabled",
        executableRoots: [dirname(process.execPath)],
        workingRoots: [root],
        allowedEnvironment: [],
        networkAccess: "external",
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
    expect(result.value.filesystem_checkpoints.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "before",
        "reactive_shim_seen",
        "probe_seen",
        "after_settlement",
      ]),
    );
    expect(result.value.reactive_run).toMatchObject({
      status: "finished",
      outcome: "passed",
      transitions: [
        expect.objectContaining({
          transition_id: "record_shim",
          trigger_event_ids: ["obs.shim_events.0"],
          action_event_ids: [
            expect.stringMatching(/^obs\.filesystem_checkpoints\./u),
          ],
        }),
        expect.objectContaining({
          transition_id: "finish_checkpoint",
          trigger_event_ids: [
            expect.stringMatching(/^obs\.filesystem_checkpoints\./u),
          ],
        }),
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
