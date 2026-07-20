import type { JsonValue } from "../domain/jsonValue.js";
import { digestProcessCommitment } from "../domain/processCapture.js";

const normalization = {
  paths: true,
  pids: true,
  ports: true,
  time_bucket_ms: 10,
  patterns: [],
};
const scenario = { executable_sha256: "0".repeat(64) };
const comparisonContract = {};
const shimPlan: JsonValue[] = [];
const replayPlan = {};

/** Minimal valid process capture used only in public contract examples. */
export const EMPTY_PROCESS_CAPTURE_EXAMPLE = {
  schema_version: 4,
  manifest: {
    rea_version: "1.1.0",
    provider_version: "4",
    platform: "fixture",
    architecture: "fixture",
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
  process_events: [],
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
} satisfies JsonValue;
