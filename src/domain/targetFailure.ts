/**
 * Why a target could not be read: one owned fact, raised once by the format
 * or filesystem owner that established it. Wrappers carry it unchanged.
 *
 * `failure_kind` is the primary machine identifier (RFC 9457's problem type).
 * The coarse `code`, its `category`, the `retry` hint, the recovery and the
 * `details` are all derived from the kind by {@link TARGET_FAILURE_PROJECTIONS}
 * and {@link targetFailureDetails}. See `docs/reference/target-failures.md`.
 *
 * The model describes the target. A caller's cancellation and an admission
 * limit describe the operation, so they keep their own error types
 * (`AnalysisCancelledError`, `AnalysisResourceConstraintError`).
 *
 * Identifiers are lower-case ASCII in American spelling.
 *
 * Areas migrate onto this model one at a time (#14239). The declarative
 * conformance registry under `tests/support/targetFailure/` lists every
 * migrated reader with a fixture per kind. When the last area has migrated,
 * a guard script rejects any other reason vocabulary.
 */

/** Every kind, in the order the error reference lists them. */
export const TARGET_FAILURE_KINDS = [
  "selection",
  "unrecognized",
  "unsupported",
  "malformed",
  "truncated",
  "integrity",
  "conflict",
  "changed",
  "access",
  "io",
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

/**
 * Where a truncated structure stopped: the bytes the input holds from the
 * structure's start, and the bytes the structure declares. Only a reader that
 * measured the input's end reports it.
 */
export interface TruncatedExtent {
  readonly availableBytes: number;
  readonly requiredBytes: number;
}

/** One input of a composite request, named by the request field that chose it. */
export interface TargetFailureInput {
  readonly field: string;
  readonly path: string;
}

/** One target failure. A variant adds only the facts its caller action needs. */
export type TargetFailure = TargetFailureFacts &
  (
    | { readonly kind: "selection" }
    | { readonly kind: "unrecognized" }
    | {
        readonly kind: "unsupported";
        /** The input holds the content, in a form this decoder cannot read. */
        readonly undecodedContent: boolean;
      }
    | { readonly kind: "malformed" }
    | {
        readonly kind: "truncated";
        /** The measured end and the length needed, when the owner measured them. */
        readonly extent?: TruncatedExtent;
      }
    | { readonly kind: "integrity" }
    | {
        readonly kind: "conflict";
        /** Two or more inputs that each parse but disagree. None is blamed. */
        readonly inputs: readonly TargetFailureInput[];
      }
    | { readonly kind: "changed" }
    | { readonly kind: "access" }
    | {
        readonly kind: "io";
        /**
         * The host reported a transient condition (EAGAIN, EINTR, a timeout)
         * rather than a persistent device error. Set from the owner's errno.
         */
        readonly transient: boolean;
      }
  );

/** The variant of one kind. */
export type TargetFailureOf<Kind extends TargetFailureKind> = Extract<
  TargetFailure,
  { readonly kind: Kind }
>;

/**
 * A format owner's refusal of the bytes it read: they are not that format at
 * all, they break or end inside a structure of the format, or they use a form
 * outside the owner's coverage.
 */
export const FORMAT_TARGET_FAILURE_KINDS = [
  "unrecognized",
  "malformed",
  "truncated",
  "unsupported",
] as const satisfies readonly TargetFailureKind[];
export type FormatTargetFailureKind =
  (typeof FORMAT_TARGET_FAILURE_KINDS)[number];
export type FormatTargetFailure = TargetFailureOf<FormatTargetFailureKind>;

/**
 * Whether a reason is a format owner's refusal, which carries the owner's
 * facts. The one list every wrapper consults, so a new kind cannot be carried
 * by some wrappers and dropped by others.
 */
export const isFormatTargetFailureKind = (
  kind: string,
): kind is FormatTargetFailureKind =>
  (FORMAT_TARGET_FAILURE_KINDS as readonly string[]).includes(kind);

/**
 * When repeating the request can help, after gRPC's status semantics:
 * `none` (never, the target itself must change), `backoff` (the unchanged
 * request may succeed later), `after_change` (only once the caller changes
 * the request or a control).
 */
export type TargetFailureRetry = "none" | "backoff" | "after_change";

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
  | "check_host";

/** The public projection of one kind. */
export interface TargetFailureProjection {
  /** A short summary of the kind that does not change per occurrence (RFC 9457 `title`). */
  readonly title: string;
  /** A coarse class derived from the kind; `failure_kind` identifies the failure. */
  readonly code:
    | "invalid_request"
    | "unsupported_target"
    | "target_integrity_mismatch"
    | "input_conflict"
    | "artifact_changed"
    | "access_denied"
    | "host_io_failed";
  readonly category:
    | "invalid_input"
    | "unsupported_target"
    | "integrity_mismatch"
    | "unavailable"
    | "execution_failure";
  /** The kind's retry hint; `io` refines it from its errno fact. */
  readonly retry: TargetFailureRetry;
  readonly recovery: TargetFailureRecovery;
}

/**
 * The single projection table. No two codes cover unrelated caller actions:
 * the four target refusals share `unsupported_target` because each needs a
 * different target or tool, and their `failure_kind` says which.
 */
export const TARGET_FAILURE_PROJECTIONS = {
  selection: {
    title: "Unselectable",
    code: "invalid_request",
    category: "invalid_input",
    retry: "after_change",
    recovery: "fix_request",
  },
  unrecognized: {
    title: "Unrecognized",
    code: "unsupported_target",
    category: "unsupported_target",
    retry: "none",
    recovery: "choose_another_tool",
  },
  unsupported: {
    title: "Unsupported",
    code: "unsupported_target",
    category: "unsupported_target",
    retry: "none",
    recovery: "choose_another_tool",
  },
  malformed: {
    title: "Malformed",
    code: "unsupported_target",
    category: "unsupported_target",
    retry: "none",
    recovery: "choose_another_target",
  },
  truncated: {
    title: "Truncated",
    code: "unsupported_target",
    category: "unsupported_target",
    retry: "none",
    recovery: "reacquire_complete_file",
  },
  integrity: {
    title: "Integrity-mismatched",
    code: "target_integrity_mismatch",
    category: "integrity_mismatch",
    retry: "none",
    recovery: "replace_or_record_integrity",
  },
  conflict: {
    title: "Conflicting",
    code: "input_conflict",
    category: "invalid_input",
    retry: "after_change",
    recovery: "check_input_pairing",
  },
  changed: {
    title: "Changed",
    code: "artifact_changed",
    category: "integrity_mismatch",
    retry: "backoff",
    recovery: "retry_on_stable_copy",
  },
  access: {
    title: "Inaccessible",
    code: "access_denied",
    category: "unavailable",
    retry: "after_change",
    recovery: "fix_permissions",
  },
  io: {
    title: "Unreadable",
    code: "host_io_failed",
    category: "execution_failure",
    retry: "none",
    recovery: "check_host",
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

/** The retry hint of one failure: its kind's, refined by an `io` errno fact. */
export const targetFailureRetry = (
  failure: TargetFailure,
): TargetFailureRetry =>
  failure.kind === "io" && failure.transient
    ? "backoff"
    : TARGET_FAILURE_PROJECTIONS[failure.kind].retry;

type DetailValue =
  | string
  | number
  | readonly Readonly<Record<string, string>>[];

/**
 * The machine-readable facts of a failure, in the public spelling. Every kind
 * reports `failure_kind` and `format`; a variant adds its own facts.
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
    case "truncated":
      return {
        ...common,
        ...(failure.extent === undefined
          ? {}
          : {
              available_bytes: failure.extent.availableBytes,
              required_bytes: failure.extent.requiredBytes,
            }),
      };
    case "conflict":
      return {
        ...common,
        inputs: failure.inputs.map(({ field, path }) => ({ field, path })),
      };
    case "selection":
    case "unrecognized":
    case "unsupported":
    case "malformed":
    case "integrity":
    case "changed":
    case "access":
    case "io":
      return common;
    default:
      return unhandledTargetFailureCase(failure);
  }
};

/**
 * Operations and providers that read what the refusing operation could not.
 * The owner names them by contract operation and provider ID; each adapter
 * spells them its own way.
 */
export interface TargetFailureAlternatives {
  readonly operations?: readonly string[];
  readonly providers?: readonly string[];
}

/**
 * How one adapter names an operation and a provider in recovery text: MCP by
 * tool name and `open_binary` argument, the CLI by command and option.
 */
export interface TargetFailureSpelling {
  readonly operation: (operation: string) => string;
  readonly provider: (providerId: string) => string;
}

/** The MCP spelling, which is also the adapter-independent one in Evidence. */
export const MCP_TARGET_FAILURE_SPELLING: TargetFailureSpelling = {
  operation: (operation) => operation,
  provider: (providerId) => `open_binary with provider_id "${providerId}"`,
};

/** The facts a recovery is rendered from, in either adapter. */
export interface TargetFailureRecoveryFacts {
  readonly operation: string;
  readonly kind: TargetFailureKind;
  readonly format: string;
  /** The conflicting inputs' request fields, in the adapter's spelling. */
  readonly inputFields?: readonly string[];
  /** The owner's errno was transient (`retry: "backoff"` for `io`). */
  readonly transient?: boolean;
  readonly alternatives?: TargetFailureAlternatives;
}

const listed = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} or ${names.at(-1) ?? ""}`;

/** The clause that names the alternatives, or a generic one without any. */
const alternativeClause = (
  alternatives: TargetFailureAlternatives | undefined,
  spelling: TargetFailureSpelling,
): string => {
  const operations = (alternatives?.operations ?? []).map(spelling.operation);
  const providers = (alternatives?.providers ?? []).map(spelling.provider);
  if (operations.length > 0 && providers.length > 0)
    return `Use ${listed(operations)} for this target, or reopen it with ${listed(providers)}`;
  if (operations.length > 0) return `Use ${listed(operations)} for this target`;
  if (providers.length > 0)
    return `Reopen this target with ${listed(providers)}`;
  return "Choose another operation or provider for this target";
};

/**
 * Render what a caller does next in one adapter's spelling. This is the only
 * place a target failure's recovery text is written; the CLI and MCP differ
 * only in `spelling`.
 */
export const renderTargetFailureRecovery = (
  facts: TargetFailureRecoveryFacts,
  spelling: TargetFailureSpelling,
): string => {
  const operation = spelling.operation(facts.operation);
  const { recovery } = TARGET_FAILURE_PROJECTIONS[facts.kind];
  switch (recovery) {
    case "fix_request":
      return "Correct the request so it names a valid target for this operation, then retry.";
    case "choose_another_tool":
      return `The selected target's ${facts.format} form is outside what ${operation} reads. ${alternativeClause(facts.alternatives, spelling)}.`;
    case "choose_another_target":
      return `The selected target's ${facts.format} bytes break that format's rules where ${operation} reads them. The request arguments are not at fault, so changing them will not help. ${alternativeClause(facts.alternatives, spelling)}, or select a well-formed copy.`;
    case "reacquire_complete_file":
      return `The selected target's ${facts.format} bytes end before a structure they declare. The request arguments are not at fault. Re-acquire the complete file and retry; do not pad or cut the bytes.`;
    case "replace_or_record_integrity":
      return "The target's bytes contradict a checksum or digest they declare. Get a fresh copy, or rerun with integrity_policy=record-and-continue to keep the observed bytes as untrusted.";
    case "check_input_pairing":
      return `The selected inputs (${facts.inputFields === undefined || facts.inputFields.length === 0 ? "all inputs" : facts.inputFields.join(", ")}) each parse but disagree, so neither is reported as damaged. Select inputs from the same build. If they are from the same build, either may be damaged or its layout may be outside coverage; each input can still be read on its own.`;
    case "retry_on_stable_copy":
      return "The target changed while it was read. Retry once it is stable, or copy it first.";
    case "fix_permissions":
      return "Host permissions denied the read. Grant read access to the selected path, then retry.";
    case "check_host":
      return facts.transient === true
        ? "The host reported a transient read failure. Retry with backoff."
        : "The host could not read the target. Check the device and file before retrying.";
    default:
      return unhandledTargetFailureCase(recovery);
  }
};

/** What a caller does next, for one failure of a known operation. */
export const targetFailureRecovery = (
  operation: string,
  failure: TargetFailure,
  alternatives?: TargetFailureAlternatives,
  spelling: TargetFailureSpelling = MCP_TARGET_FAILURE_SPELLING,
): string =>
  renderTargetFailureRecovery(
    {
      operation,
      kind: failure.kind,
      format: failure.format,
      ...(failure.kind === "conflict"
        ? { inputFields: failure.inputs.map(({ field }) => field) }
        : {}),
      transient: failure.kind === "io" && failure.transient,
      ...(alternatives === undefined ? {} : { alternatives }),
    },
    spelling,
  );
