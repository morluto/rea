import type { JsonValue } from "../jsonValue.js";
import { digestProcessCommitment } from "./processCapture.js";

const normalization = {
  paths: true,
  pids: true,
  ports: true,
  time_bucket_ms: 10,
  patterns: [],
};
const scenario = { executable_sha256: "0".repeat(64) };
const comparisonContract = {};

/** Minimal valid process capture retained as a public contract example. */
export const EMPTY_PROCESS_CAPTURE_EXAMPLE = {
  manifest: {
    rea_version: "1.1.0",
    provider_version: "3",
    platform: "fixture",
    architecture: "fixture",
    pty_backend: "node-pty",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:00.001Z",
    scenario,
    comparison_contract: comparisonContract,
    full_scenario_sha256: digestProcessCommitment(scenario),
    comparison_contract_sha256: digestProcessCommitment(comparisonContract),
    selected_executable_sha256: "0".repeat(64),
    executable_sha256: "0".repeat(64),
    executable_identity: {
      state: "path_metadata_unchanged",
      reason: null,
    },
    normalization_sha256: digestProcessCommitment(normalization),
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
