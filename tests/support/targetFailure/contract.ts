import type {
  TargetFailureKind,
  TargetFailureRetry,
} from "../../../src/domain/targetFailure.js";

/**
 * The public target-failure contract, spelled out independently of the
 * projection table so a change to the table fails its tests. It matches
 * `docs/reference/target-failures.md`.
 */
export const TARGET_FAILURE_CONTRACT = {
  selection: {
    code: "invalid_request",
    category: "invalid_input",
    retry: "after_change",
  },
  unrecognized: {
    code: "unsupported_target",
    category: "unsupported_target",
    retry: "none",
  },
  unsupported: {
    code: "unsupported_target",
    category: "unsupported_target",
    retry: "none",
  },
  malformed: {
    code: "unsupported_target",
    category: "unsupported_target",
    retry: "none",
  },
  truncated: {
    code: "unsupported_target",
    category: "unsupported_target",
    retry: "none",
  },
  integrity: {
    code: "target_integrity_mismatch",
    category: "integrity_mismatch",
    retry: "none",
  },
  conflict: {
    code: "input_conflict",
    category: "invalid_input",
    retry: "after_change",
  },
  changed: {
    code: "artifact_changed",
    category: "integrity_mismatch",
    retry: "backoff",
  },
  access: {
    code: "access_denied",
    category: "unavailable",
    retry: "after_change",
  },
  io: {
    code: "host_io_failed",
    category: "execution_failure",
    retry: "none",
  },
} as const satisfies Record<
  TargetFailureKind,
  {
    readonly code: string;
    readonly category: string;
    readonly retry: TargetFailureRetry;
  }
>;
