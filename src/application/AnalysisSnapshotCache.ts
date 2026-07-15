import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { EvidenceBundle } from "../domain/evidenceBundle.js";
import {
  EvidenceIntegrityError,
  NoBinaryOpenError,
  type AnalysisError,
  type EvidenceLimitError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  analysisQueryId,
  createAnalysisSnapshotEntry,
  snapshotBinding,
  snapshotMatchesProfile,
  snapshotMatchesTarget,
  snapshotTarget,
  type AnalysisSnapshot,
  type AnalysisSnapshotEntry,
  type AnalysisSnapshotBinding,
  type AnalysisSnapshotTarget,
} from "../domain/analysisSnapshot.js";
import type {
  AnalysisExecution,
  AnalysisOperation,
  CapabilityDescriptor,
} from "./AnalysisProvider.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/toolContracts.js";

const STATEFUL_OPERATIONS: ReadonlySet<AnalysisOperation> = new Set([
  "health",
  "current_address",
  "current_procedure",
  "current_document",
  "goto_address",
  "list_documents",
  "set_current_document",
]);

const CURSOR_DEFAULT_OPERATIONS: ReadonlySet<AnalysisOperation> = new Set([
  "address_name",
  "comment",
  "inline_comment",
  "next_address",
  "prev_address",
  "xrefs",
]);

const DOCUMENT_SCOPED_OPERATIONS: ReadonlySet<AnalysisOperation> = new Set(
  OFFICIAL_TOOL_CONTRACTS.map(({ name }) => name).filter(
    (name) =>
      name !== "current_document" &&
      name !== "list_documents" &&
      name !== "set_current_document",
  ),
);

/** Whether an operation is immutable and independent of provider UI state. */
export const isSnapshotCacheable = (
  operation: AnalysisOperation,
  descriptor: CapabilityDescriptor | undefined,
  parameters: Readonly<Record<string, JsonValue>>,
): descriptor is CapabilityDescriptor =>
  !STATEFUL_OPERATIONS.has(operation) &&
  (!DOCUMENT_SCOPED_OPERATIONS.has(operation) ||
    typeof parameters.document === "string") &&
  (!CURSOR_DEFAULT_OPERATIONS.has(operation) ||
    typeof parameters.address === "string") &&
  descriptor?.effects.mutatesArtifact === false &&
  descriptor.effects.mayWriteFilesystem === false &&
  descriptor.effects.changesPermissions === false;

/** Bounded in-memory cache for one immutable binary identity. */
export class AnalysisSnapshotCache {
  readonly #entries = new Map<string, AnalysisSnapshotEntry>();
  #target: AnalysisSnapshotTarget | undefined;
  #binding: AnalysisSnapshotBinding | undefined;

  /** Whether staged entries belong to the supplied target and profile. */
  matches(
    target: BinaryTarget,
    profile: AnalysisProfileCommitment | undefined,
  ): boolean {
    return (
      (this.#target === undefined && this.#binding === undefined) ||
      (this.#target !== undefined &&
        this.#binding !== undefined &&
        profile !== undefined &&
        snapshotMatchesTarget(this.#target, target) &&
        snapshotMatchesProfile(this.#binding, profile))
    );
  }

  /** Replace cache state when the target or selected profile changes. */
  select(target: BinaryTarget, profile: AnalysisProfileCommitment): void {
    if (!this.matches(target, profile)) this.#entries.clear();
    this.#target = snapshotTarget(target);
    this.#binding = snapshotBinding(profile);
  }

  /** Merge already-validated entries and return the new-entry count. */
  stage(snapshot: AnalysisSnapshot): number {
    if (
      (this.#target !== undefined &&
        JSON.stringify(this.#target) !== JSON.stringify(snapshot.target)) ||
      (this.#binding !== undefined &&
        !snapshotMatchesProfile(
          this.#binding,
          snapshot.binding.analysis_profile,
        ))
    )
      this.#entries.clear();
    this.#target = structuredClone(snapshot.target);
    this.#binding = structuredClone(snapshot.binding);
    let imported = 0;
    for (const entry of snapshot.entries) {
      if (!this.#entries.has(entry.query_id)) imported += 1;
      this.#entries.set(entry.query_id, structuredClone(entry));
    }
    return imported;
  }

  /** Build a complete snapshot for an active target. */
  export(
    target: BinaryTarget | undefined,
    profile: AnalysisProfileCommitment | undefined,
    evidenceBundle: EvidenceBundle,
  ): Result<AnalysisSnapshot, NoBinaryOpenError> {
    if (target === undefined || profile === undefined)
      return err(new NoBinaryOpenError());
    return ok({
      snapshot_version: 2,
      target: snapshotTarget(target),
      binding: snapshotBinding(profile),
      entries: this.entries(),
      evidence_bundle: structuredClone(evidenceBundle),
    });
  }

  /** Validate target identity, merge evidence atomically, then stage entries. */
  import(
    snapshot: AnalysisSnapshot,
    active:
      | {
          readonly target: BinaryTarget;
          readonly profile: AnalysisProfileCommitment;
        }
      | undefined,
    mergeEvidence: (
      bundle: EvidenceBundle,
    ) => Result<number, EvidenceIntegrityError | EvidenceLimitError>,
  ): Result<number, AnalysisError> {
    if (
      active !== undefined &&
      (!snapshotMatchesTarget(snapshot.target, active.target) ||
        !snapshotMatchesProfile(snapshot.binding, active.profile))
    )
      return err(
        new EvidenceIntegrityError(
          "Analysis snapshot profile_mismatch: target, provider, or analysis profile does not match the active binary",
        ),
      );
    const importedEvidence = mergeEvidence(snapshot.evidence_bundle);
    return importedEvidence.ok ? ok(this.stage(snapshot)) : importedEvidence;
  }

  /** Return canonical entries for persistence. */
  entries(): AnalysisSnapshotEntry[] {
    return [...this.#entries.values()]
      .sort((left, right) => left.query_id.localeCompare(right.query_id))
      .map((entry) => structuredClone(entry));
  }

  /** Replay an exact provider-specific query, marking its cached provenance. */
  lookup(
    target: BinaryTarget,
    profile: AnalysisProfileCommitment,
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
  ): AnalysisExecution | undefined {
    const queryId = analysisQueryId(
      snapshotTarget(target),
      snapshotBinding(profile),
      operation,
      parameters,
    );
    const cached = this.#entries.get(queryId);
    if (cached === undefined) return undefined;
    const subject = cached.execution.subject;
    return structuredClone({
      result: cached.execution.result,
      rawResult: cached.execution.raw_result,
      provider: cached.execution.provider,
      analysisProfile: structuredClone(profile),
      limitations: [
        ...cached.execution.limitations,
        "Loaded from a local REA analysis snapshot; this call did not re-run the provider.",
      ],
      locations: cached.execution.locations,
      subject:
        subject === null
          ? null
          : subject.architecture === null
            ? {
                path: subject.path,
                sha256: subject.sha256,
                format: subject.format,
              }
            : {
                path: subject.path,
                sha256: subject.sha256,
                format: subject.format,
                architecture: subject.architecture,
              },
    });
  }

  /** Record one successful immutable call unless the cache is full. */
  record(input: {
    readonly target: BinaryTarget;
    readonly profile: AnalysisProfileCommitment;
    readonly operation: AnalysisOperation;
    readonly parameters: Readonly<Record<string, JsonValue>>;
    readonly execution: AnalysisExecution;
  }): void {
    const { target, profile, operation, parameters, execution } = input;
    if (this.#entries.size >= 10_000) return;
    this.select(target, profile);
    const entry = createAnalysisSnapshotEntry({
      target: snapshotTarget(target),
      binding: snapshotBinding(profile),
      operation,
      parameters,
      execution,
    });
    this.#entries.set(entry.query_id, entry);
  }

  /** Forget all target-bound entries. */
  clear(): void {
    this.#entries.clear();
    this.#target = undefined;
    this.#binding = undefined;
  }
}
