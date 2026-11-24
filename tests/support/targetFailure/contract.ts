import type { TargetFailureKind } from "../../../src/domain/targetFailure.js";

/**
 * The public target-failure contract, spelled out independently of the
 * projection table so a change to the table fails its tests. It matches
 * `docs/reference/target-failures.md`.
 */
export const TARGET_FAILURE_CONTRACT = {
  selection: {
    code: "invalid_request",
    category: "invalid_input",
    retryable: false,
  },
  unrecognised: {
    code: "unsupported_target",
    category: "unsupported_target",
    retryable: false,
  },
  unsupported: {
    code: "unsupported_target",
    category: "unsupported_target",
    retryable: false,
  },
  malformed: {
    code: "unsupported_target",
    category: "unsupported_target",
    retryable: false,
  },
  truncated: {
    code: "unsupported_target",
    category: "unsupported_target",
    retryable: false,
  },
  integrity: {
    code: "artifact_integrity_mismatch",
    category: "integrity_mismatch",
    retryable: false,
  },
  conflict: {
    code: "invalid_request",
    category: "invalid_input",
    retryable: false,
  },
  changed: {
    code: "artifact_changed",
    category: "integrity_mismatch",
    retryable: true,
  },
  access: { code: "access_denied", category: "unavailable", retryable: false },
  io: {
    code: "artifact_operation_failed",
    category: "execution_failure",
    retryable: false,
  },
  cancelled: { code: "cancelled", category: "cancelled", retryable: true },
  resource: {
    code: "resource_constraint",
    category: "resource_constraint",
    retryable: false,
  },
} as const satisfies Record<
  TargetFailureKind,
  {
    readonly code: string;
    readonly category: string;
    readonly retryable: boolean;
  }
>;
