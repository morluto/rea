import type { FixedAllowance } from "../domain/fixedAllowanceRemediation.js";
import type { ArtifactReaderLimitFact } from "../domain/artifactReaderLimits.js";
import type {
  ArtifactAdmissionLimit,
  ArtifactIntegrityCheck,
  ArtifactLimitBoundary,
  ArtifactOperationError,
} from "../domain/artifactOperationError.js";
import type {
  ArtifactContainerIntegrityPair,
  ArtifactIntegrityClaim,
  ArtifactIntegrityDetails,
} from "../domain/artifactIntegrity.js";
import type { ArtifactFormatMetadata } from "../domain/artifactFormatMetadata.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import type { AnalysisCleanupLease } from "./AnalysisCleanupLease.js";
import type { Readable } from "node:stream";
import type {
  ArtifactCommand,
  ArtifactInventoryCoverage,
  ArtifactTraversalOmissionKind,
} from "../domain/artifactGraph.js";
import type { ZipPackageFormat } from "../domain/zipPackageFormat.js";
import type {
  AnalysisCleanupObservation,
  AnalysisPartialObservation,
} from "../domain/analysisErrorBase.js";
import { errorMessage } from "../kernel/errorMessage.js";
import type { LimitRef } from "../domain/parseFailure.js";

export interface ArtifactReaderFailureOptions extends ErrorOptions {
  /** Recovery guidance established by the producing adapter, separate from diagnostics. */
  readonly userMessage?: string | undefined;
  /** Regular-file path observed behind a rejected selected symlink; retry still revalidates it. */
  readonly resolvedPath?: string | undefined;
  readonly cancellation?: { readonly reason: unknown } | undefined;
  readonly cleanup?: AnalysisCleanupObservation | undefined;
  /** Exact authority for all reported cleanup; undefined leaves ownership unknown. */
  readonly cleanupLeases?: readonly AnalysisCleanupLease[] | undefined;
  readonly partialObservation?: AnalysisPartialObservation | undefined;
  /** The constrained resource bound for a limit failure. */
  readonly boundary?: ArtifactLimitBoundary;
  /** Named admission whose recovery must not be inferred from other limit text. */
  readonly admission?: ArtifactAdmissionLimit;
  readonly readerLimit?: ArtifactReaderLimitFact;
  readonly parserLimit?: LimitRef;
  /** For a `limit` failure, the release-fixed allowance that refused the input. */
  readonly fixedAllowance?: ArtifactFixedLimit;
  /** For an `integrity` failure, the check that failed, when the reader names it. */
  readonly integrityCheck?: ArtifactIntegrityCheck | undefined;
}

/** Archive-neutral entry metadata. Reader adapters never choose output paths. */
export interface ArtifactEntry {
  readonly path: string;
  /** Exact reader-source path or opaque key before logical path mapping. */
  readonly sourcePath?: string;
  readonly kind: "file" | "directory" | "symlink" | "slice" | "metadata";
  readonly declaredSize: number | null;
  readonly compressedSize: number | null;
  readonly executable: boolean;
  readonly encrypted: boolean;
  readonly byteOffset: number | null;
  /** Stored source extent; expanded size may differ for compressed members. */
  readonly byteLength?: number;
  readonly declaredIntegrity: ArtifactIntegrityClaim | null;
  readonly formatMetadata?: ArtifactFormatMetadata;
  readonly unpacked: boolean;
  readonly limitations: readonly string[];
  readonly adapterKey: string;
  /** Filesystem identity captured during traversal, when supplied by an adapter. */
  readonly sourceIdentity?: {
    readonly device: bigint;
    readonly inode: bigint;
    readonly size: bigint;
    readonly mode: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
  };
}

/** Compare captured filesystem identity and mutable metadata at a read boundary. */
export const sameArtifactSourceIdentity = (
  expected: ArtifactEntry["sourceIdentity"],
  observed: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly mode: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
  },
): boolean =>
  expected !== undefined &&
  observed.dev === expected.device &&
  observed.ino === expected.inode &&
  observed.size === expected.size &&
  observed.mode === expected.mode &&
  observed.mtimeNs === expected.mtimeNs &&
  observed.ctimeNs === expected.ctimeNs;

/** Snapshot mutable entry metadata before the producer later validates open(). */
export const copyArtifactEntry = (entry: ArtifactEntry): ArtifactEntry => ({
  ...entry,
  limitations: [...entry.limitations],
  declaredIntegrity:
    entry.declaredIntegrity === null ? null : { ...entry.declaredIntegrity },
  ...(entry.formatMetadata === undefined
    ? {}
    : { formatMetadata: structuredClone(entry.formatMetadata) }),
  ...(entry.sourceIdentity === undefined
    ? {}
    : { sourceIdentity: { ...entry.sourceIdentity } }),
});

/**
 * Require that an opened entry is one this reader produced, unchanged. Throws
 * the `integrity` failure naming `foreign-entry` when the reader has no such
 * entry, or `entry-metadata` when the supplied facts differ from it.
 */
export function assertProducedEntry<Produced extends ArtifactEntry>(
  entry: ArtifactEntry,
  produced: Produced | undefined,
  message: string,
): asserts produced is Produced {
  if (produced !== undefined && sameArtifactEntry(entry, produced)) return;
  throw new ArtifactReaderFailure("integrity", message, {
    integrityCheck: produced === undefined ? "foreign-entry" : "entry-metadata",
  });
}

/** Compare every portable and adapter-owned fact supplied with an entry. */
export const sameArtifactEntry = (
  entry: ArtifactEntry,
  produced: ArtifactEntry,
): boolean =>
  entry.path === produced.path &&
  entry.sourcePath === produced.sourcePath &&
  entry.kind === produced.kind &&
  entry.declaredSize === produced.declaredSize &&
  entry.compressedSize === produced.compressedSize &&
  entry.executable === produced.executable &&
  entry.encrypted === produced.encrypted &&
  entry.byteOffset === produced.byteOffset &&
  entry.byteLength === produced.byteLength &&
  sameDeclaredIntegrity(entry.declaredIntegrity, produced.declaredIntegrity) &&
  sameFormatMetadata(entry.formatMetadata, produced.formatMetadata) &&
  entry.unpacked === produced.unpacked &&
  entry.adapterKey === produced.adapterKey &&
  entry.limitations.length === produced.limitations.length &&
  entry.limitations.every(
    (limitation, index) => limitation === produced.limitations[index],
  ) &&
  entry.sourceIdentity?.device === produced.sourceIdentity?.device &&
  entry.sourceIdentity?.inode === produced.sourceIdentity?.inode &&
  entry.sourceIdentity?.size === produced.sourceIdentity?.size &&
  entry.sourceIdentity?.mode === produced.sourceIdentity?.mode &&
  entry.sourceIdentity?.mtimeNs === produced.sourceIdentity?.mtimeNs &&
  entry.sourceIdentity?.ctimeNs === produced.sourceIdentity?.ctimeNs;

const sameDeclaredIntegrity = (
  left: ArtifactEntry["declaredIntegrity"],
  right: ArtifactEntry["declaredIntegrity"],
): boolean =>
  left === right ||
  (left !== null &&
    left !== undefined &&
    right !== null &&
    right !== undefined &&
    left.algorithm === right.algorithm &&
    left.digest === right.digest);

/** Compare cloned JSON facts structurally while retaining the primitive fast path. */
const sameFormatMetadata = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameFormatMetadata(value, right[index]))
    );
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(
      ([key, value]) =>
        Object.hasOwn(right, key) &&
        sameFormatMetadata(value, Reflect.get(right, key)),
    )
  );
};

/** One entry or subtree deliberately excluded from a traversal. */
export interface ArtifactTraversalOmission {
  readonly path: string;
  readonly kind: ArtifactTraversalOmissionKind;
}

/** Facts from an exhausted traversal, separate from entry content certainty. */
export interface ArtifactReaderTraversal {
  readonly status: ArtifactInventoryCoverage["status"];
  readonly limitations: readonly string[];
  /** Number of directory entries examined, including names omitted before decoding. */
  readonly examinedEntries?: number;
}

/**
 * Per-iterator observation sink; adapters report intentional omissions without shared state.
 * A reader declares its coverage through `onCoverage` before its iterator ends,
 * including complete coverage; consumers that need a completeness claim
 * iterate through `declaredArtifactEntries`, which treats silence as unknown.
 */
export interface ArtifactTraversalOptions {
  readonly onOmission?: (omission: ArtifactTraversalOmission) => void;
  readonly onCoverage?: (coverage: ArtifactReaderTraversal) => void;
}

/** The sink of a traversal whose coverage feeds a completeness claim. */
export type ArtifactTraversalSink = Required<ArtifactTraversalOptions>;

/** Read-only adapter over one directory, archive, or virtual container. */
export interface ArtifactReader {
  readonly format:
    | "directory"
    | ZipPackageFormat
    | "asar"
    | "ines"
    | "godot-pck"
    | "unityfs"
    | "wxapkg"
    | "axml"
    | "arsc"
    | "uimage"
    | "android-boot-image"
    | "android-ota-payload"
    | "uefi"
    | "pyinstaller"
    | "dotnet-bundle"
    | "bun-standalone"
    | "deno-standalone"
    | "node-sea"
    | "intel-hex"
    | "srec"
    | "esp-image"
    | "uf2"
    | "dfuse"
    | "esp-flash-image"
    | "fit"
    | "ntfs-mft"
    | "file";
  entries(
    signal?: AbortSignal,
    options?: ArtifactTraversalOptions,
  ): AsyncIterable<ArtifactEntry>;
  open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable>;
  provenance(): readonly ArtifactCommand[];
  formatMetadata?(): ArtifactFormatMetadata | undefined;
  /** A checksum the container declares over its own bytes, with the observed value. */
  containerIntegrity?(): ArtifactContainerIntegrityPair | undefined;
  /** Bind materialization to the exact inventoried carrier before creating outputs. */
  prepareContainer?(
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void>;
  close(): Promise<void>;
}

/** Typed adapter failure translated at provider boundary. */
/** A selected-file read whose own cleanup failed. */
export type CleanupFailedRead = ArtifactReaderFailure & {
  readonly cleanup: AnalysisCleanupObservation;
};

/** Why an artifact reader failed. */
export type ArtifactReaderFailureReason = ArtifactOperationError["reason"];

export class ArtifactReaderFailure extends Error {
  readonly userMessage: string | undefined;
  readonly resolvedPath: string | undefined;
  readonly cancellation: { readonly reason: unknown } | undefined;
  readonly cleanup: AnalysisCleanupObservation | undefined;
  readonly cleanupLeases: readonly AnalysisCleanupLease[] | undefined;
  partialObservation: AnalysisPartialObservation | undefined;
  /** The constrained bound for a `limit` reason, when the reader knows it. */
  readonly boundary: ArtifactLimitBoundary | undefined;
  /** Named admission for a limit whose public recovery is owned by the producer. */
  readonly admission: ArtifactAdmissionLimit | undefined;
  readonly readerLimit: ArtifactReaderLimitFact | undefined;
  readonly parserLimit: LimitRef | undefined;
  readonly fixedAllowance: ArtifactFixedLimit | undefined;
  readonly integrityCheck: ArtifactIntegrityCheck | undefined;

  /** An `integrity` failure names the check that failed. */
  constructor(
    reason: "integrity",
    message: string,
    options: ArtifactReaderFailureOptions & {
      readonly integrityCheck: ArtifactIntegrityCheck;
    },
    details?: ArtifactIntegrityDetails,
  );
  constructor(
    reason: Exclude<ArtifactReaderFailureReason, "integrity">,
    message: string,
    options?: ArtifactReaderFailureOptions,
    details?: ArtifactIntegrityDetails,
  );
  /**
   * A rebuild whose reason is not a literal carries the check explicitly, as
   * {@link primaryFacts} does, so a rewrapped integrity failure keeps it.
   */
  constructor(
    reason: ArtifactReaderFailureReason,
    message: string,
    options: ArtifactReaderFailureOptions & {
      readonly integrityCheck: ArtifactIntegrityCheck | undefined;
    },
    details?: ArtifactIntegrityDetails,
  );
  constructor(
    readonly reason: ArtifactReaderFailureReason,
    message: string,
    options?: ArtifactReaderFailureOptions,
    readonly details?: ArtifactIntegrityDetails,
  ) {
    super(message, options);
    this.name = "ArtifactReaderFailure";
    this.userMessage = options?.userMessage;
    this.resolvedPath = options?.resolvedPath;
    this.cancellation =
      reason === "cancelled"
        ? (options?.cancellation ?? { reason: options?.cause })
        : undefined;
    this.cleanup = options?.cleanup;
    this.cleanupLeases =
      options?.cleanupLeases ?? (this.cleanup === undefined ? [] : undefined);
    this.partialObservation = options?.partialObservation;
    this.boundary = options?.boundary;
    this.admission = options?.admission;
    this.readerLimit = options?.readerLimit;
    this.parserLimit = options?.parserLimit;
    this.fixedAllowance = options?.fixedAllowance;
    this.integrityCheck = options?.integrityCheck;
  }

  /**
   * Reader-owned facts a rebuilt failure must keep. Each rebuild chooses its
   * own cause, cleanup, cancellation and partial observation.
   */
  primaryFacts(): Pick<
    ArtifactReaderFailureOptions,
    | "userMessage"
    | "resolvedPath"
    | "boundary"
    | "admission"
    | "readerLimit"
    | "parserLimit"
    | "fixedAllowance"
  > & { readonly integrityCheck: ArtifactIntegrityCheck | undefined } {
    return {
      ...(this.userMessage === undefined
        ? {}
        : { userMessage: this.userMessage }),
      ...(this.resolvedPath === undefined
        ? {}
        : { resolvedPath: this.resolvedPath }),
      ...(this.boundary === undefined ? {} : { boundary: this.boundary }),
      ...(this.admission === undefined ? {} : { admission: this.admission }),
      ...(this.readerLimit === undefined
        ? {}
        : { readerLimit: this.readerLimit }),
      ...(this.parserLimit === undefined
        ? {}
        : { parserLimit: this.parserLimit }),
      ...(this.fixedAllowance === undefined
        ? {}
        : { fixedAllowance: this.fixedAllowance }),
      integrityCheck: this.integrityCheck,
    };
  }

  /** Retain completed facts when a later artifact step fails. */
  retainPartialObservation(observation: AnalysisPartialObservation): this {
    this.partialObservation ??= observation;
    return this;
  }

  /** Preserve the primary failure and observation. Supplied leases must cover all merged cleanup. */
  static withCleanup(
    cause: unknown,
    cleanup: AnalysisCleanupObservation,
    partialObservation?: AnalysisPartialObservation,
    cleanupLeases?: readonly AnalysisCleanupLease[],
  ): ArtifactReaderFailure {
    const primary =
      cause instanceof ArtifactReaderFailure
        ? cause
        : new ArtifactReaderFailure("io", errorMessage(cause), {
            cause,
            ...(cause instanceof AnalysisError
              ? {
                  partialObservation: cause.partialObservation,
                  ...(cause.cleanupIncomplete
                    ? {
                        cleanup: ArtifactReaderFailure.cleanupObservation(
                          cause,
                          [],
                        ),
                      }
                    : {}),
                }
              : {}),
          });
    const mergedObservation = partialObservation ?? primary.partialObservation;
    return new ArtifactReaderFailure(
      primary.reason,
      primary.message,
      {
        cause: primary,
        // The constrained bound survives cleanup wrapping, or a file-size
        // refusal would be reported as a memory constraint once a close fails.
        ...primary.primaryFacts(),
        cancellation: primary.cancellation,
        cleanup: combineCleanup(primary.cleanup, cleanup),
        cleanupLeases:
          cleanupLeases ??
          (cleanup === primary.cleanup ? primary.cleanupLeases : undefined),
        ...(mergedObservation === undefined
          ? {}
          : { partialObservation: mergedObservation }),
      },
      primary.details,
    );
  }

  /** Give otherwise opaque cleanup failures a concrete owned resource. */
  static cleanupObservation(
    cause: unknown,
    resource: string | readonly string[],
  ): AnalysisCleanupObservation {
    if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined)
      return cause.cleanup;
    if (cause instanceof AnalysisError && cause.cleanupIncomplete)
      return {
        reason: cause.cleanup?.reason ?? cause.message,
        resources: [...cause.cleanupResources],
      };
    return {
      reason: errorMessage(cause),
      resources: typeof resource === "string" ? [resource] : [...resource],
    };
  }
}

/**
 * A release-fixed reader ceiling. The reader states its value, so a consumer
 * that carries the ceiling to another process or projection keeps it.
 */
export type ArtifactFixedLimit = FixedAllowance & {
  readonly limit: number;
  readonly unit: string;
};

/**
 * Refuse input above a release-fixed reader ceiling. `outcome` states what
 * exceeded it; CLI and MCP derive the recovery from the typed allowance.
 */
export const artifactFixedLimitFailure = (
  allowance: ArtifactFixedLimit,
  outcome: string,
  boundary: ArtifactLimitBoundary = "capacity",
  options?: ErrorOptions,
): ArtifactReaderFailure =>
  new ArtifactReaderFailure("limit", outcome, {
    ...options,
    boundary,
    userMessage: outcome,
    fixedAllowance: allowance,
  });

const combineCleanup = (
  primary: AnalysisCleanupObservation | undefined,
  cleanup: AnalysisCleanupObservation,
): AnalysisCleanupObservation =>
  primary === undefined || primary === cleanup
    ? cleanup
    : {
        reason: `${primary.reason}; ${cleanup.reason}`,
        resources: [...new Set([...primary.resources, ...cleanup.resources])],
      };

/** Read explicit source authority; unrelated domain cleanup remains unresolved. */
export const artifactPrimaryCleanupLeases = (
  cause: unknown,
): readonly AnalysisCleanupLease[] | undefined =>
  cause instanceof ArtifactReaderFailure
    ? cause.cleanupLeases
    : cause instanceof AnalysisError && cause.cleanupIncomplete
      ? undefined
      : [];

/** Known member identities whose content cannot be read; never a reader shutdown. */
export class ArtifactEntryContentUnavailable extends ArtifactReaderFailure {
  readonly traversal: ArtifactReaderTraversal | undefined;
  constructor(
    message: string,
    readonly limitation: string,
    options?: ErrorOptions & { readonly traversal?: ArtifactReaderTraversal },
    details?: ArtifactIntegrityDetails,
  ) {
    super("unavailable", message, options, details);
    this.traversal = options?.traversal;
  }
}
