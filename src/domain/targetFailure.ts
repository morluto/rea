/**
 * Why a target could not be read: one owned fact, raised once by the format
 * or filesystem owner that established it. Wrappers carry it unchanged.
 * The public `code`, `category`, `retryable`, recovery and `details` are
 * derived from `kind` by {@link TARGET_FAILURE_PROJECTIONS} and
 * {@link targetFailureDetails}. See `docs/reference/target-failures.md`.
 *
 * Areas migrate onto this model one at a time (#14239). The declarative
 * conformance registry under `tests/support/targetFailure/` lists every
 * migrated reader with a fixture per kind. When the last area has migrated,
 * a guard script rejects any other reason vocabulary.
 */

/** Every kind, in the order the error reference lists them. */
export const TARGET_FAILURE_KINDS = [
  "selection",
  "unrecognised",
  "unsupported",
  "malformed",
  "truncated",
  "integrity",
  "conflict",
  "changed",
  "access",
  "io",
  "cancelled",
  "resource",
] as const;
export type TargetFailureKind = (typeof TARGET_FAILURE_KINDS)[number];

/** Facts every kind may carry. `detail` is for people; never parse it. */
export interface TargetFailureFacts {
  /** The format whose owner established the failure, such as `elf`. */
  readonly format: string;
  readonly detail: string;
  /** Byte offset of the structure that failed, when the owner knows it. */
  readonly offset?: number;
  /** The structure or field that failed, when the owner names it. */
  readonly field?: string;
}

/** One input of a composite request, named by the request field that chose it. */
export interface TargetFailureInput {
  readonly field: string;
  readonly path: string;
}

/**
 * One target failure. A variant adds only the facts its caller action needs.
 * Kinds the model reserves for areas that have not migrated yet still have
 * their projection row, so every consumer switch is total.
 */
export type TargetFailure = TargetFailureFacts &
  (
    | { readonly kind: "selection" }
    | { readonly kind: "unrecognised" }
    | {
        readonly kind: "unsupported";
        /** The input holds the content, in a form this decoder cannot read. */
        readonly undecodedContent: boolean;
      }
    | { readonly kind: "malformed" }
    | {
        readonly kind: "truncated";
        /** Bytes present from the structure's start, when measured. */
        readonly availableBytes?: number;
        /** Bytes the structure declares, when measured. */
        readonly requiredBytes?: number;
      }
    | { readonly kind: "integrity" }
    | {
        readonly kind: "conflict";
        /** Two or more inputs that each parse but disagree. None is blamed. */
        readonly inputs: readonly TargetFailureInput[];
      }
    | { readonly kind: "changed" }
    | { readonly kind: "access" }
    | { readonly kind: "io" }
    | { readonly kind: "cancelled" }
    | { readonly kind: "resource" }
  );

/** The variant of one kind. */
export type TargetFailureOf<Kind extends TargetFailureKind> = Extract<
  TargetFailure,
  { readonly kind: Kind }
>;

/** Bytes that break, or end inside, a structure of the format being read. */
export type MalformedTargetFailure = TargetFailureOf<"malformed" | "truncated">;

/** What a caller should do next. Each adapter renders it in its own words. */
export type TargetFailureRecovery =
  | "fix_request"
  | "choose_another_tool"
  | "choose_another_target"
  | "reacquire_complete_file"
  | "replace_or_record_integrity"
  | "check_input_pairing"
  | "retry_on_stable_copy"
  | "fix_permissions"
  | "check_host"
  | "none"
  | "raise_named_control";

/** The public projection of one kind. */
export interface TargetFailureProjection {
  /** A short summary of the kind that does not change per occurrence (RFC 9457 `title`). */
  readonly title: string;
  readonly code:
    | "invalid_request"
    | "unsupported_target"
    | "artifact_integrity_mismatch"
    | "artifact_changed"
    | "access_denied"
    | "artifact_operation_failed"
    | "cancelled"
    | "resource_constraint";
  readonly category:
    | "invalid_input"
    | "unsupported_target"
    | "integrity_mismatch"
    | "unavailable"
    | "execution_failure"
    | "cancelled"
    | "resource_constraint";
  /** Whether repeating the unchanged request may succeed. */
  readonly retryable: boolean;
  readonly recovery: TargetFailureRecovery;
}

/**
 * The single projection table. `retryable` follows gRPC's split: only a
 * concurrent change (ABORTED) and a cancellation succeed when repeated
 * unchanged; every other kind needs the caller to change something first.
 */
export const TARGET_FAILURE_PROJECTIONS = {
  selection: {
    title: "Unselectable",
    code: "invalid_request",
    category: "invalid_input",
    retryable: false,
    recovery: "fix_request",
  },
  unrecognised: {
    title: "Unrecognised",
    code: "unsupported_target",
    category: "unsupported_target",
    retryable: false,
    recovery: "choose_another_tool",
  },
  unsupported: {
    title: "Unsupported",
    code: "unsupported_target",
    category: "unsupported_target",
    retryable: false,
    recovery: "choose_another_tool",
  },
  malformed: {
    title: "Malformed",
    code: "unsupported_target",
    category: "unsupported_target",
    retryable: false,
    recovery: "choose_another_target",
  },
  truncated: {
    title: "Truncated",
    code: "unsupported_target",
    category: "unsupported_target",
    retryable: false,
    recovery: "reacquire_complete_file",
  },
  integrity: {
    title: "Integrity-mismatched",
    code: "artifact_integrity_mismatch",
    category: "integrity_mismatch",
    retryable: false,
    recovery: "replace_or_record_integrity",
  },
  conflict: {
    title: "Conflicting",
    code: "invalid_request",
    category: "invalid_input",
    retryable: false,
    recovery: "check_input_pairing",
  },
  changed: {
    title: "Changed",
    code: "artifact_changed",
    category: "integrity_mismatch",
    retryable: true,
    recovery: "retry_on_stable_copy",
  },
  access: {
    title: "Inaccessible",
    code: "access_denied",
    category: "unavailable",
    retryable: false,
    recovery: "fix_permissions",
  },
  io: {
    title: "Unreadable",
    code: "artifact_operation_failed",
    category: "execution_failure",
    retryable: false,
    recovery: "check_host",
  },
  cancelled: {
    title: "Cancelled",
    code: "cancelled",
    category: "cancelled",
    retryable: true,
    recovery: "none",
  },
  resource: {
    title: "Limited",
    code: "resource_constraint",
    category: "resource_constraint",
    retryable: false,
    recovery: "raise_named_control",
  },
} as const satisfies Readonly<
  Record<TargetFailureKind, TargetFailureProjection>
>;

/** Reports a case a switch did not handle; unreachable when the switch is total. */
export const unhandledTargetFailureCase = (value: never): never => {
  throw new TypeError(
    `Unhandled target failure case: ${JSON.stringify(value)}`,
  );
};

type DetailValue =
  | string
  | number
  | readonly Readonly<Record<string, string>>[];

/**
 * The machine-readable facts of a failure, in the public spelling. Every kind
 * reports `failure_kind` and `format`; `format_failure` stays for the two
 * byte-structure kinds that reported it before this model.
 */
export const targetFailureDetails = (
  failure: TargetFailure,
): Readonly<Record<string, DetailValue>> => {
  const common = {
    failure_kind: failure.kind,
    format: failure.format,
    ...(failure.offset === undefined ? {} : { offset: failure.offset }),
    ...(failure.field === undefined ? {} : { field: failure.field }),
  };
  switch (failure.kind) {
    case "malformed":
      return { format_failure: failure.kind, ...common };
    case "truncated":
      return {
        format_failure: failure.kind,
        ...common,
        ...(failure.availableBytes === undefined
          ? {}
          : { available_bytes: failure.availableBytes }),
        ...(failure.requiredBytes === undefined
          ? {}
          : { required_bytes: failure.requiredBytes }),
      };
    case "conflict":
      return {
        ...common,
        inputs: failure.inputs.map(({ field, path }) => ({ field, path })),
      };
    case "selection":
    case "unrecognised":
    case "unsupported":
    case "integrity":
    case "changed":
    case "access":
    case "io":
    case "cancelled":
    case "resource":
      return common;
    default:
      return unhandledTargetFailureCase(failure);
  }
};

/** What a caller does next, for one failure of a known operation. */
export const targetFailureRecovery = (
  operation: string,
  failure: TargetFailure,
): string => {
  const { recovery } = TARGET_FAILURE_PROJECTIONS[failure.kind];
  switch (recovery) {
    case "fix_request":
      return "Correct the request so it names a valid target for this operation, then retry.";
    case "choose_another_tool":
      return `The selected target's ${failure.format} form is outside what ${operation} reads. Choose another operation or provider for this target.`;
    case "choose_another_target":
      return `The selected target's ${failure.format} bytes break that format's rules where ${operation} reads them. The request arguments are not at fault, so changing them will not help. Choose another operation or provider for this target, or select a well-formed copy.`;
    case "reacquire_complete_file":
      return `The selected target's ${failure.format} bytes end before a structure they declare. The request arguments are not at fault. Re-acquire the complete file and retry; do not pad or cut the bytes.`;
    case "replace_or_record_integrity":
      return "The target's bytes contradict a checksum or digest they declare. Get a fresh copy, or rerun with integrity_policy=record-and-continue to keep the observed bytes as untrusted.";
    case "check_input_pairing":
      return "The selected inputs each parse but disagree. Check that they belong together; neither is reported as damaged.";
    case "retry_on_stable_copy":
      return "The target changed while it was read. Retry once it is stable, or copy it first.";
    case "fix_permissions":
      return "Host permissions denied the read. Grant read access to the selected path, then retry.";
    case "check_host":
      return "The host could not read the target. Check the device and file, then retry.";
    case "none":
      return "The operation was cancelled. Start it again when ready.";
    case "raise_named_control":
      return "A named limit stopped the work. Raise that control or select a smaller target.";
    default:
      return unhandledTargetFailureCase(recovery);
  }
};
