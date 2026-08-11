import { expect, it } from "vitest";

import { digestProcessCommitment } from "./processCapture.js";
import {
  compareUnverifiedProcessCaptures as compareProcessCaptures,
  emptyProcessCapture as emptyCapture,
} from "./processCapture.fixture.js";

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
    replay_transitions: [],
    reactive_run: null,
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

it("compares replay state transitions as protocol evidence", () => {
  const replayPlan = {
    machine: {
      initial_state: "anonymous",
      states: [
        { name: "anonymous" },
        { name: "authenticated", terminal: true },
      ],
      transitions: [
        {
          id: "login",
          from: "anonymous",
          to: "authenticated",
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
      ],
      max_transitions: 1,
    },
  };
  const empty = emptyCapture();
  const baseline = {
    ...empty,
    manifest: {
      ...empty.manifest,
      replay_plan: replayPlan,
      replay_plan_sha256: digestProcessCommitment(replayPlan),
    },
  };
  const transitioned = {
    ...baseline,
    replay_transitions: [
      {
        sequence: 0,
        at_ms: 0,
        transition_id: "login",
        state_before: "anonymous",
        state_after: "authenticated",
        sensitive_aliases: ["token"],
      },
    ],
  };

  expect(compareProcessCaptures(baseline, transitioned)).toMatchObject({
    status: "changed",
    protocol: "added",
  });
});
