import { expect, it } from "vitest";

import {
  compareProcessCaptures,
  digestProcessCommitment,
  type ProcessCapture,
} from "../../../src/domain/processCapture.js";

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
    replay_transitions: [],
    reactive_run: null,
    event_journal: [],
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

it("treats equivalent normalization records as equal regardless of member order", () => {
  const capture = emptyCapture();

  expect(
    compareProcessCaptures(capture, {
      ...capture,
      normalization: {
        patterns: [],
        time_bucket_ms: 10,
        ports: true,
        pids: true,
        paths: true,
      },
    }),
  ).toMatchObject({
    status: "unchanged",
    first_divergence: { status: "none" },
  });
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
    replay_transitions: [],
    reactive_run: null,
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
