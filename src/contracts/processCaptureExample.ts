import type { JsonValue } from "../domain/jsonValue.js";

/** Minimal valid process capture used only in public contract examples. */
export const EMPTY_PROCESS_CAPTURE_EXAMPLE = {
  schema_version: 2,
  normalization: {
    paths: true,
    pids: true,
    ports: true,
    time_bucket_ms: 10,
    patterns: [],
  },
  frames: [],
  exit: { code: 0, signal: null, reason: "exited" },
  process_samples: [],
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
