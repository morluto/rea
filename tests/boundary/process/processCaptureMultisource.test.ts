import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { itWithCaptureCapability } from "./processCaptureCapability.js";

import { captureProcessScenario } from "../../../src/application/ProcessHarness.js";
import {
  parseProcessScenario,
  type ProcessCapture,
} from "../../../src/domain/processCapture.js";
import { processCaptureIssues } from "../../../src/domain/processCapture.fixture.js";

type EventSource = "process" | "filesystem" | "http" | "websocket" | "shim";

function eventTrigger(
  source: EventSource,
  exact: Record<string, unknown>,
  ignoreFields: readonly string[],
) {
  return {
    kind: "event" as const,
    source,
    exact,
    ignore_fields: ignoreFields,
    since: { kind: "scenario_start" as const },
    consume: true,
    cardinality: { min: 1, max: 1 },
  };
}

function collectionTriggers() {
  const terminalTrigger = (literal: string) => ({
    kind: "terminal_text" as const,
    literal,
    occurrence: 1,
    since: { kind: "scenario_start" as const },
    consume: false,
  });
  return [
    {
      kind: "any" as const,
      triggers: [
        terminalTrigger("Collecting"),
        terminalTrigger("unreachable-alternative"),
      ],
    },
    eventTrigger(
      "process",
      {
        pid: 3,
        parent_pid: 1,
        command: "rea-reactive-worker",
        process_group_id: 1,
        session_id: process.platform === "darwin" ? null : 1,
      },
      ["at_ms"],
    ),
    eventTrigger(
      "filesystem",
      {
        name: "ready_snapshot",
        truncated: false,
      },
      ["at_ms", "files", "effects"],
    ),
    eventTrigger(
      "shim",
      {
        command: "codex",
        route_index: 0,
        arguments: ["probe"],
        working_directory: "<working-directory>",
        outcome: "matched",
      },
      ["sequence", "at_ms"],
    ),
    {
      kind: "sequence" as const,
      triggers: [
        eventTrigger(
          "http",
          {
            protocol: "http",
            direction: "request",
            method: "GET",
            path: "/reactive",
            data: "",
            outcome: "matched",
          },
          ["sequence", "at_ms"],
        ),
        eventTrigger(
          "websocket",
          {
            protocol: "websocket",
            direction: "received",
            method: null,
            path: "/ws",
            data: "reactive-client",
            outcome: "matched",
          },
          ["sequence", "at_ms"],
        ),
      ],
    },
  ];
}

function createMultiSourceScenario(root: string, script: string) {
  return parseProcessScenario({
    executable: process.execPath,
    arguments: [script, "codex"],
    working_directory: root,
    filesystem_observation_paths: [root],
    normalization: { paths: true },
    replay: {
      http: [{ method: "GET", path: "/reactive", status: 200, body: "ok" }],
      websocket_messages: ["reactive-server"],
    },
    command_shims: [
      {
        name: "codex",
        routes: [
          {
            arguments: ["probe"],
            outputs: [],
            termination: { type: "exit", code: 0 },
          },
        ],
      },
    ],
    reactive: {
      initial_state: "ready",
      deadline_ms: 8_000,
      states: [
        {
          id: "ready",
          max_visits: 1,
          deadline_ms: 3_000,
          on: [
            {
              id: "checkpoint_ready",
              priority: 0,
              max_uses: 1,
              when: {
                kind: "terminal_text",
                literal: "Ready",
                occurrence: 1,
                since: { kind: "scenario_start" },
                consume: true,
              },
              actions: [{ type: "checkpoint", name: "ready_snapshot" }],
              target: { kind: "goto", state: "collecting" },
            },
          ],
        },
        {
          id: "collecting",
          max_visits: 1,
          deadline_ms: 5_000,
          on: [
            {
              id: "finish_all_sources",
              priority: 0,
              max_uses: 1,
              when: { kind: "all", triggers: collectionTriggers() },
              actions: [],
              target: { kind: "finish" },
            },
          ],
        },
      ],
    },
  });
}

// This is the single multi-source acceptance matrix for the process boundary.
itWithCaptureCapability(
  "runs the committed multi-source reactive fixture deterministically",
  async () => {
    const root = await createTestTempDirectory("rea-reactive-e2e-");
    const script = fileURLToPath(
      new URL("../../fixtures/processReactiveScenario.mjs", import.meta.url),
    );
    const run = () =>
      captureProcessScenario(createMultiSourceScenario(root, script));
    try {
      const first = await run();
      const second = await run();
      if (!first.ok) throw first.error;
      if (!second.ok) throw second.error;
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      const trace = (capture: ProcessCapture) =>
        capture.reactive_run?.transitions.map((transition) => ({
          transition_id: transition.transition_id,
          from: transition.state_before,
          to: transition.state_after,
          outcome: transition.outcome,
          trigger_collections: transition.trigger_event_ids.map(
            (id) => id.split(".")[1],
          ),
        }));
      expect(
        first.value.reactive_run?.outcome,
        JSON.stringify({
          run: first.value.reactive_run,
          processes: first.value.process_samples,
          checkpoints: first.value.filesystem_checkpoints,
          shims: first.value.shim_events,
          protocols: first.value.protocol_events,
        }),
      ).toBe("passed");
      expect(trace(first.value)).toEqual(trace(second.value));
      expect(trace(first.value)).toEqual([
        expect.objectContaining({ transition_id: "checkpoint_ready" }),
        expect.objectContaining({
          transition_id: "finish_all_sources",
          trigger_collections: expect.arrayContaining([
            "frames",
            "process_samples",
            "filesystem_checkpoints",
            "shim_events",
            "protocol_events",
          ]),
        }),
      ]);
      for (const outcome of ["action_rejected", "target_lost"] as const) {
        const failedActionCapture = {
          ...first.value,
          reactive_run: {
            status: "finished" as const,
            outcome,
            active_state: "ready",
            transitions: [],
            controls: [],
          },
        };
        expect(
          processCaptureIssues(failedActionCapture).filter(({ path }) =>
            path.startsWith("reactive_run"),
          ),
        ).toEqual([]);
      }
      expect(first.value.truncated).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
