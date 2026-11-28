import { HOST_PLATFORM } from "../../platform/HostPlatform.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import type { AnalysisProfileCommitment } from "../../domain/analysisProfile.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { isImmutableJsonSnapshot } from "../../domain/immutableJson.js";
import type { EvidenceBundle } from "../../domain/evidenceBundle.js";
import {
  EvidenceIntegrityError,
  AnalysisSnapshotMismatchError,
} from "../../domain/evidenceErrors.js";
import { NoBinaryOpenError } from "../../domain/configurationErrors.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  evidenceSubject,
  evidenceSubjectDisplay,
  evidenceSubjectTarget,
  rebindEvidenceSubjectTargetPath,
  type Evidence,
  type EvidenceSubjectTarget,
} from "../../domain/evidence.js";
import {
  sameTargetIdentity,
  unknownTarget,
} from "../../domain/targetIdentity.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  analysisQueryId,
  evidenceMatchesEntry,
  evidenceMatchesWorkflowEntry,
  createAnalysisSnapshotEntry,
  createAnalysisSnapshotWorkflowEntry,
  snapshotBinding,
  snapshotBindingMismatch,
  snapshotMatchesProfile,
  snapshotTarget,
  parseAnalysisSnapshot,
  immutableAnalysisSnapshot,
  type AnalysisSnapshot,
  type AnalysisSnapshotEntry,
  type AnalysisSnapshotWorkflowEntry,
  type AnalysisSnapshotBinding,
  type AnalysisSnapshotTarget,
  type SnapshotBindingMismatch,
} from "../../domain/analysisSnapshot.js";
import type {
  AnalysisExecution,
  AnalysisOperation,
  CapabilityDescriptor,
  ExecutionOptions,
} from "../../ports/AnalysisProvider.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../../contracts/officialToolContracts.js";
import { compareUnicodeCodePoints } from "../../domain/unicodeCodePointOrder.js";

import type { EvidenceMetadataReplacement } from "../investigation/EvidenceLedger.js";
import {
  snapshotReplayBinding,
  type SnapshotReplayBinding,
} from "./AnalysisSnapshotReplayBinding.js";
import { createInvestigationEvidenceClosureChecker } from "../investigation/InvestigationEvidence.js";

const RELATIONSHIP_OPERATIONS: ReadonlySet<AnalysisOperation> = new Set([
  "procedure_callers",
  "procedure_callees",
]);

// These reports depend on selected bundle resources or loader context beyond
// the immutable executable identity carried by a binary analysis snapshot.
const RESOURCE_SCOPED_OPERATIONS: ReadonlySet<AnalysisOperation> = new Set([
  "decode_interface_builder",
  "inspect_asset_catalog",
  "inspect_keyed_archive",
  "trace_dylib_resolution",
]);

const STATEFUL_OPERATIONS: ReadonlySet<AnalysisOperation> = new Set([
  "health",
  "current_address",
  "current_procedure",
  "current_document",
  "goto_address",
  "list_documents",
]);

const CURSOR_DEFAULT_OPERATIONS: ReadonlySet<AnalysisOperation> = new Set([
  "address_name",
  "comment",
  "inline_comment",
  "next_address",
  "prev_address",
  "xrefs",
]);

const DOCUMENT_SCOPED_OPERATIONS: ReadonlySet<string> = new Set(
  OFFICIAL_TOOL_CONTRACTS.map(({ name }) => name).filter(
    (name) => name !== "current_document" && name !== "list_documents",
  ),
);

/** Maximum duplicated result bindings retained across direct and workflow queries. */
const SNAPSHOT_CACHE_ENTRY_CEILING = 10_000;

/** A file target without its recorded display name, which follows the replayed path. */
const withoutDisplayName = ({
  name: _name,
  ...target
}: EvidenceSubjectTarget): EvidenceSubjectTarget => target;

const replayDocumentSelected = (
  operation: AnalysisOperation,
  parameters: Readonly<Record<string, JsonValue>>,
): boolean =>
  !DOCUMENT_SCOPED_OPERATIONS.has(operation) ||
  typeof parameters.document === "string";

/**
 * A headless Ghidra session holds exactly one private Program, bound to the
 * caller's target, so a caller's own read without a document selector still
 * names it; GUI defaults do not. Workflow-internal reads carry no context and
 * stay out of the ledger. Whether the read may replay stays with the declared
 * cache policy and effects.
 */
const isSoleProgramRead = (
  descriptor: CapabilityDescriptor | undefined,
  context: ExecutionOptions["snapshotContext"],
): boolean => context !== undefined && descriptor?.provider.id === "ghidra";

/**
 * Caller and callee walks omit `document`. Their observations are still
 * Evidence. Other document-scoped reads, including `procedure_pseudo_code`
 * from `decompile_all`, already keep each body in the file-backed export.
 * Copying those bodies into the in-memory ledger would retain the export.
 */
const DOCUMENTLESS_SOURCE_EVIDENCE_OPERATIONS: ReadonlySet<AnalysisOperation> =
  new Set(["procedure_callers", "procedure_callees"]);

/**
 * Whether a source observation is safe to retain as Evidence.
 * A missing document selector blocks snapshot replay. A producer can require
 * its observation as Evidence independently of whether it can be replayed.
 */
export const isSourceEvidenceRetainable = (
  operation: AnalysisOperation,
  descriptor: CapabilityDescriptor | undefined,
  parameters: Readonly<Record<string, JsonValue>>,
  options: {
    readonly snapshotContext?: ExecutionOptions["snapshotContext"];
    readonly requiresSourceEvidence?: boolean;
  } = {},
): descriptor is CapabilityDescriptor =>
  !STATEFUL_OPERATIONS.has(operation) &&
  !RESOURCE_SCOPED_OPERATIONS.has(operation) &&
  (!DOCUMENT_SCOPED_OPERATIONS.has(operation) ||
    typeof parameters.document === "string" ||
    DOCUMENTLESS_SOURCE_EVIDENCE_OPERATIONS.has(operation) ||
    options.requiresSourceEvidence === true ||
    isSoleProgramRead(descriptor, options.snapshotContext)) &&
  (!CURSOR_DEFAULT_OPERATIONS.has(operation) ||
    typeof parameters.address === "string") &&
  descriptor?.effects.mutatesArtifact === false &&
  (options.requiresSourceEvidence === true ||
    descriptor.cachePolicy === "snapshot" ||
    descriptor.effects.mayWriteFilesystem === false) &&
  descriptor.effects.changesPermissions === false;

/**
 * A session's own read without a document selector is recorded, so a saved
 * snapshot carries it, but it replays only in a session the caller opened from
 * a snapshot. Without one, the same call still asks the live engine, whose own
 * caches make a repeat cheap.
 */
export const replaysOnlyFromImportedSnapshot = (
  operation: AnalysisOperation,
  parameters: Readonly<Record<string, JsonValue>>,
  context: ExecutionOptions["snapshotContext"],
): boolean =>
  context === "session-target" &&
  !replayDocumentSelected(operation, parameters);

/** Explicit standalone decompiles must run even if a snapshot has a matching entry. */
export const requestsStandaloneDecompile = (
  operation: string,
  parameters: Readonly<Record<string, JsonValue>>,
): boolean =>
  operation === "procedure_pseudo_code" &&
  (parameters.analysis === "independent_fresh" ||
    parameters.analysis === "call_destination");

/** Whether an observation can additionally be replayed as a snapshot. */
export const isSnapshotCacheable = (
  operation: AnalysisOperation,
  descriptor: CapabilityDescriptor | undefined,
  parameters: Readonly<Record<string, JsonValue>>,
  context?: ExecutionOptions["snapshotContext"],
): descriptor is CapabilityDescriptor =>
  !requestsStandaloneDecompile(operation, parameters) &&
  isSourceEvidenceRetainable(operation, descriptor, parameters, {
    snapshotContext: context,
  }) &&
  (replayDocumentSelected(operation, parameters) ||
    isSoleProgramRead(descriptor, context)) &&
  descriptor.cachePolicy !== "live";

/**
 * Why a one-shot read the caller asked to snapshot cannot replay, or
 * undefined when the snapshot can replay it. The same predicates decide
 * whether the session records the replay entry.
 */
export const oneShotSnapshotReplayRefusal = ({
  operation,
  descriptor,
  parameters,
  execution,
  profiled,
}: {
  readonly operation: AnalysisOperation;
  readonly descriptor: CapabilityDescriptor;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly execution: Pick<AnalysisExecution, "cachePolicy">;
  /** The selected profile belongs to the executing provider. */
  readonly profiled: boolean;
}): string | undefined => {
  const context = "one-shot-target" as const;
  if (
    profiled &&
    isSnapshotCacheable(operation, descriptor, parameters, context) &&
    execution.cachePolicy !== "live"
  )
    return undefined;
  const reason =
    descriptor.cachePolicy === "live" || execution.cachePolicy === "live"
      ? `${descriptor.provider.id} declares this result live, so it must be observed again`
      : requestsStandaloneDecompile(operation, parameters)
        ? "a standalone decompile always runs"
        : `${descriptor.provider.id} does not bind this read to the snapshot's target and profile`;
  return snapshotNotSavedLimitation(reason);
};

/** The limitation a caller who asked for a snapshot gets when its answer cannot replay. */
export const snapshotNotSavedLimitation = (reason: string): string =>
  `Not saved for snapshot replay: ${reason}. The snapshot records this Evidence, and repeating the call runs the provider again.`;

/**
 * Why `record` would skip an execution's replay entry, or undefined when it
 * would keep it. `record` uses the same answer, so the notice cannot drift.
 */
const executionReplayRefusal = (
  execution: AnalysisExecution,
): string | undefined =>
  // The snapshot format does not carry reference truncation or stored-pointer
  // classifications. Replaying either would present a capped or untyped read
  // as the live observation.
  execution.referencesTruncated === true ||
  execution.referenceClassifications !== undefined ||
  execution.referenceCoverageGaps !== undefined
    ? "the snapshot format cannot keep this result's reference truncation or classifications"
    : undefined;

/** Limitation that marks every observation replayed from a snapshot. */
const SNAPSHOT_REPLAY_LIMITATION =
  "Loaded from a local REA analysis snapshot; this call did not re-run the provider.";

/** Windows Ghidra must admit the selected source through its native snapshot owner. */
export const requiresNativeSourceAdmissionBeforeReplay = (
  providerId: string | undefined,
): boolean => HOST_PLATFORM.platform === "win32" && providerId === "ghidra";

/** Bounded in-memory cache for one immutable binary identity. */
export class AnalysisSnapshotCache {
  readonly #entries = new Map<string, AnalysisSnapshotEntry>();
  // Null is ambiguous provenance; a pending ID is an exact parent whose source
  // closure was missing and can be checked again against the owning ledger.
  readonly #replayBindings = new Map<
    string,
    SnapshotReplayBinding | { readonly pendingEvidenceId: string } | null
  >();
  readonly #workflowEntries = new Map<string, AnalysisSnapshotWorkflowEntry>();
  #target: AnalysisSnapshotTarget | undefined;
  #binding: AnalysisSnapshotBinding | undefined;
  #imported = false;

  /** Whether the caller staged a snapshot into the current entries. */
  get holdsImportedSnapshot(): boolean {
    return this.#imported;
  }

  /** Whether staged entries belong to the supplied target and profile. */
  matches(
    target: BinaryTarget,
    profile: AnalysisProfileCommitment | undefined,
  ): boolean {
    return this.mismatch(target, profile) === undefined;
  }

  /** Explain staged mismatch without treating missing binding facts as absent. */
  mismatch(
    target: BinaryTarget,
    profile: AnalysisProfileCommitment | undefined,
  ): SnapshotBindingMismatch | undefined {
    if (this.#target === undefined && this.#binding === undefined)
      return undefined;
    if (this.#target === undefined || this.#binding === undefined)
      return { staged_binding: "incomplete" };
    return snapshotBindingMismatch(
      { target: this.#target, binding: this.#binding },
      target,
      profile,
    );
  }

  /** Replace cache state when the target or selected profile changes. */
  select(target: BinaryTarget, profile: AnalysisProfileCommitment): void {
    if (!this.matches(target, profile)) this.#clearEntries();
    this.#target = snapshotTarget(target);
    this.#binding = snapshotBinding(profile);
  }

  /** Merge already-validated entries and return the new-entry count. */
  stage(snapshot: AnalysisSnapshot): number {
    snapshot = immutableAnalysisSnapshot(snapshot);
    if (
      (this.#target !== undefined &&
        !sameTargetIdentity(this.#target.identity, snapshot.target.identity)) ||
      (this.#binding !== undefined &&
        !snapshotMatchesProfile(
          this.#binding,
          snapshot.binding.analysis_profile,
        ))
    )
      this.#clearEntries();
    this.#target = structuredClone(snapshot.target);
    this.#binding = structuredClone(snapshot.binding);
    let imported = 0;
    const stagedQueryIds = new Set<string>();
    for (const entry of snapshot.entries) {
      if (!this.#entries.has(entry.query_id) && !this.#hasCapacity()) continue;
      if (!this.#entries.has(entry.query_id)) imported += 1;
      this.#entries.set(entry.query_id, entry);
      stagedQueryIds.add(entry.query_id);
      this.#replayBindings.delete(entry.query_id);
    }
    // Snapshot validation authenticated these records. Recover the original
    // identity before lookup adds replay caveats; do not mint a new record.
    const evidenceByQuery = new Map<string, Evidence>();
    const records = new Map(
      snapshot.evidence_bundle.records.map((record) => [
        record.evidence_id,
        record,
      ]),
    );
    const lookup = (id: string) => records.get(id);
    const checkClosure = createInvestigationEvidenceClosureChecker({
      evidenceForAnalysis: lookup,
    });
    const ambiguous = new Set<string>();
    for (const evidence of snapshot.evidence_bundle.records) {
      const queryId = analysisQueryId(
        snapshot.target,
        snapshot.binding,
        evidence.operation,
        evidence.parameters,
      );
      if (!stagedQueryIds.has(queryId)) continue;
      const entry = this.#entries.get(queryId);
      if (
        entry === undefined ||
        !evidenceMatchesEntry(evidence, entry, snapshot)
      )
        continue;
      const previous = evidenceByQuery.get(queryId);
      if (
        previous !== undefined &&
        previous.evidence_id !== evidence.evidence_id
      )
        ambiguous.add(queryId);
      else evidenceByQuery.set(queryId, evidence);
    }
    for (const [queryId, evidence] of evidenceByQuery) {
      if (ambiguous.has(queryId)) {
        this.#replayBindings.set(queryId, null);
        continue;
      }
      this.#replayBindings.set(
        queryId,
        snapshotReplayBinding(evidence, lookup, checkClosure) ?? {
          pendingEvidenceId: evidence.evidence_id,
        },
      );
    }
    for (const entry of snapshot.workflow_entries) {
      if (!this.#workflowEntries.has(entry.query_id) && !this.#hasCapacity())
        continue;
      if (!this.#workflowEntries.has(entry.query_id)) imported += 1;
      this.#workflowEntries.set(entry.query_id, entry);
    }
    return imported;
  }

  /** Refresh subject bindings backed by replaced authenticated metadata. */
  refreshEvidenceMetadata(
    replacements: readonly EvidenceMetadataReplacement[],
  ): void {
    if (
      replacements.length === 0 ||
      this.#target === undefined ||
      this.#binding === undefined
    )
      return;
    const currentRecords = new Map(
      replacements.map(({ current }) => [current.evidence_id, current]),
    );
    for (const [queryId, binding] of this.#replayBindings) {
      if (
        binding === null ||
        "pendingEvidenceId" in binding ||
        binding.sourceEvidence === undefined
      )
        continue;
      const sources = binding.sourceEvidence;
      if (!sources.some((source) => currentRecords.has(source.evidence_id)))
        continue;
      this.#replayBindings.set(queryId, {
        evidenceId: binding.evidenceId,
        sourceEvidence: Object.freeze(
          sources.map(
            (source) => currentRecords.get(source.evidence_id) ?? source,
          ),
        ),
      });
    }
    const header = { target: this.#target, binding: this.#binding };
    for (const { previous, current } of replacements) {
      const display = evidenceSubjectDisplay(current);
      if (
        display === undefined ||
        evidenceSubjectDisplay(previous)?.local_path === display.local_path
      )
        continue;
      const queryId = analysisQueryId(
        header.target,
        header.binding,
        previous.operation,
        previous.parameters,
      );
      const entry = this.#entries.get(queryId);
      const entryIdentity = entry?.execution.subject.identity;
      if (
        entry !== undefined &&
        entryIdentity?.kind === "file" &&
        evidenceMatchesEntry(previous, entry, header)
      )
        this.#entries.set(queryId, {
          ...entry,
          execution: {
            ...entry.execution,
            subject: { identity: entryIdentity, ...display },
          },
        });
      const workflow = this.#workflowEntries.get(queryId);
      const workflowIdentity = workflow?.execution.subject.identity;
      if (
        workflow !== undefined &&
        workflowIdentity?.kind === "file" &&
        evidenceMatchesWorkflowEntry(previous, workflow, header)
      )
        this.#workflowEntries.set(queryId, {
          ...workflow,
          execution: {
            ...workflow.execution,
            subject: { identity: workflowIdentity, ...display },
          },
        });
    }
  }

  /** Build a complete snapshot for an active target. */
  export(
    target: BinaryTarget | undefined,
    profile: AnalysisProfileCommitment | undefined,
    evidenceBundle: EvidenceBundle,
  ): Result<AnalysisSnapshot, AnalysisError> {
    if (target === undefined || profile === undefined)
      return err(new NoBinaryOpenError());
    try {
      const persistedTarget = snapshotTarget(target);
      const namesTarget = (subject: Evidence["subject"]): boolean =>
        subject.identity.kind === "file" &&
        subject.identity.sha256 === target.sha256;
      const binding = snapshotBinding(profile);
      // In-memory replay can preserve unbound and child-artifact observations.
      // A persisted target snapshot can authenticate only rows whose Evidence
      // has that target subject; the record owner applies the same scope to its bundle.
      const entries = [...this.#entries.values()]
        .filter((entry) => namesTarget(entry.execution.subject))
        .sort((left, right) =>
          compareUnicodeCodePoints(left.query_id, right.query_id),
        );
      const workflows = [...this.#workflowEntries.values()]
        .filter((entry) => namesTarget(entry.execution.subject))
        .sort((left, right) =>
          compareUnicodeCodePoints(left.query_id, right.query_id),
        );
      // Parsing owns the returned JSON and metadata; pre-cloning the same
      // payloads here only adds another full materialization.
      return ok(
        parseAnalysisSnapshot({
          target: persistedTarget,
          binding,
          entries,
          workflow_entries: workflows,
          evidence_bundle: evidenceBundle,
        }),
      );
    } catch (cause: unknown) {
      return err(
        new EvidenceIntegrityError("Analysis snapshot validation failed", {
          cause,
        }),
      );
    }
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
    mergeEvidence: (bundle: EvidenceBundle) => Result<number, AnalysisError>,
  ): Result<number, AnalysisError> {
    let validated: AnalysisSnapshot;
    try {
      validated = immutableAnalysisSnapshot(snapshot);
    } catch (cause: unknown) {
      return err(
        new EvidenceIntegrityError("Analysis snapshot validation failed", {
          cause,
        }),
      );
    }
    if (active !== undefined) {
      const mismatch = snapshotBindingMismatch(
        validated,
        active.target,
        active.profile,
      );
      if (mismatch !== undefined)
        return err(
          new AnalysisSnapshotMismatchError(
            "Analysis snapshot target, provider, or analysis profile does not match the active binary",
            mismatch,
          ),
        );
    }
    const importedEvidence = mergeEvidence(validated.evidence_bundle);
    if (!importedEvidence.ok) return importedEvidence;
    const staged = this.stage(validated);
    this.#imported = true;
    return ok(staged);
  }

  /** Return canonical entries for persistence. */
  entries(): AnalysisSnapshotEntry[] {
    return [...this.#entries.values()]
      .sort((left, right) =>
        compareUnicodeCodePoints(left.query_id, right.query_id),
      )
      .map((entry) => structuredClone(entry));
  }

  /** Return canonical composed-workflow entries for persistence. */
  workflowEntries(): AnalysisSnapshotWorkflowEntry[] {
    return [...this.#workflowEntries.values()]
      .sort((left, right) =>
        compareUnicodeCodePoints(left.query_id, right.query_id),
      )
      .map((entry) => structuredClone(entry));
  }

  /** Record one exact derived workflow result unless the shared cache is full. */
  recordWorkflow(input: {
    readonly target: BinaryTarget;
    readonly profile: AnalysisProfileCommitment;
    readonly operation: string;
    readonly parameters: Readonly<Record<string, JsonValue>>;
    readonly execution: {
      readonly result: JsonValue;
      readonly rawResult: JsonValue | null;
      readonly provider: AnalysisExecution["provider"];
      readonly analysisProfile: AnalysisProfileCommitment;
      readonly limitations: readonly string[];
      readonly relationshipCoverage?: AnalysisExecution["relationshipCoverage"];
      readonly locations: AnalysisExecution["locations"];
      readonly subject: Evidence["subject"];
    };
  }): void {
    this.select(input.target, input.profile);
    const resolvedTarget = this.#target ?? snapshotTarget(input.target);
    const resolvedBinding = this.#binding ?? snapshotBinding(input.profile);
    const queryId = analysisQueryId(
      resolvedTarget,
      resolvedBinding,
      input.operation,
      input.parameters,
    );
    if (!this.#workflowEntries.has(queryId) && !this.#hasCapacity()) return;
    const entry = createAnalysisSnapshotWorkflowEntry({
      target: resolvedTarget,
      binding: resolvedBinding,
      operation: input.operation,
      parameters: input.parameters,
      execution: input.execution,
    });
    this.#workflowEntries.set(entry.query_id, entry);
  }

  /** Replay an exact provider-specific query, marking its cached provenance. */
  lookup(
    target: BinaryTarget,
    profile: AnalysisProfileCommitment,
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    lookup?: (id: string) => Evidence | undefined,
  ): AnalysisExecution | undefined {
    const queryId = analysisQueryId(
      snapshotTarget(target),
      snapshotBinding(profile),
      operation,
      parameters,
    );
    const cached = this.#entries.get(queryId);
    if (cached === undefined) return undefined;
    let binding = this.#replayBindings.get(queryId);
    // Do not turn a refused provenance selection into a fresh, unlinked record.
    // The provider must produce a new observation before this query can replay.
    if (binding === null) return undefined;
    if (binding !== undefined && "pendingEvidenceId" in binding) {
      const parent = lookup?.(binding.pendingEvidenceId);
      if (parent === undefined || lookup === undefined) return undefined;
      const restored = snapshotReplayBinding(parent, lookup);
      if (restored === null) return undefined;
      this.#replayBindings.set(queryId, restored);
      binding = restored;
    }
    // Replay names the file at the current path; its display name follows
    // that path, as the live observation's would.
    const cachedTarget = evidenceSubjectTarget(cached.execution.subject);
    const subject =
      cachedTarget === undefined
        ? null
        : rebindEvidenceSubjectTargetPath(
            withoutDisplayName(cachedTarget),
            target,
          );
    const resultPayload = isImmutableJsonSnapshot(cached.execution.result)
      ? cached.execution.result
      : structuredClone(cached.execution.result);
    const rawPayload = isImmutableJsonSnapshot(cached.execution.raw_result)
      ? cached.execution.raw_result
      : structuredClone(cached.execution.raw_result);
    const execution: AnalysisExecution = {
      ...(binding === undefined ? {} : { evidenceId: binding.evidenceId }),
      result: resultPayload,
      rawResult: rawPayload,
      provider: structuredClone(cached.execution.provider),
      analysisProfile: structuredClone(profile),
      limitations: [
        ...cached.execution.limitations,
        SNAPSHOT_REPLAY_LIMITATION,
      ],
      ...(cached.execution.relationship_coverage === null &&
      RELATIONSHIP_OPERATIONS.has(operation)
        ? {
            relationshipCoverage: {
              status: "unknown" as const,
              reason: "Snapshot entry does not report relationship coverage.",
              limited_directions:
                operation === "procedure_callers"
                  ? (["callers"] as ["callers"])
                  : operation === "procedure_callees"
                    ? (["callees"] as ["callees"])
                    : (["callers", "callees"] as ["callers", "callees"]),
            },
          }
        : cached.execution.relationship_coverage === null
          ? {}
          : {
              relationshipCoverage: structuredClone(
                cached.execution.relationship_coverage,
              ),
            }),
      locations: structuredClone(cached.execution.locations),
      subject: subject === null ? null : structuredClone(subject),
    };
    return binding?.sourceEvidence === undefined
      ? execution
      : { ...execution, sourceEvidence: binding.sourceEvidence };
  }

  /** Record one successful immutable call unless the cache is full. */
  record(
    input: {
      readonly target: BinaryTarget;
      readonly profile: AnalysisProfileCommitment;
      readonly operation: AnalysisOperation;
      readonly parameters: Readonly<Record<string, JsonValue>>;
      readonly execution: AnalysisExecution;
      readonly evidence?: Evidence;
    },
    lookup?: (id: string) => Evidence | undefined,
  ): void {
    const { target, profile, operation, parameters, execution } = input;
    this.select(target, profile);
    if (executionReplayRefusal(execution) !== undefined) return;
    let sourceBinding: SnapshotReplayBinding | undefined;
    if ((execution.sourceEvidence?.length ?? 0) > 0) {
      if (execution.evidenceId === undefined || lookup === undefined) return;
      const parent = lookup(execution.evidenceId);
      if (parent === undefined) return;
      const closed = snapshotReplayBinding(parent, lookup);
      if (closed === null) return;
      sourceBinding = closed;
    }
    const resolvedTarget = this.#target ?? snapshotTarget(target);
    const resolvedBinding = this.#binding ?? snapshotBinding(profile);
    const queryId = analysisQueryId(
      resolvedTarget,
      resolvedBinding,
      operation,
      parameters,
    );
    if (!this.#entries.has(queryId) && !this.#hasCapacity()) return;
    const entry = createAnalysisSnapshotEntry({
      target: resolvedTarget,
      binding: resolvedBinding,
      operation,
      parameters,
      execution: {
        ...execution,
        subject: evidenceSubject(
          execution.subject === undefined
            ? target
            : (execution.subject ?? unknownTarget("not-observed")),
        ),
      },
    });
    this.#entries.set(entry.query_id, entry);
    if (execution.evidenceId === undefined)
      this.#replayBindings.delete(entry.query_id);
    else
      this.#replayBindings.set(
        entry.query_id,
        sourceBinding ?? {
          evidenceId: execution.evidenceId,
          ...(input.evidence === undefined
            ? {}
            : { sourceEvidence: Object.freeze([input.evidence]) }),
        },
      );
  }

  /**
   * Why recording this execution would keep no replay entry: its reference
   * facts, or a full cache that holds no entry for this query yet.
   */
  recordingRefusal(input: {
    readonly target: BinaryTarget;
    readonly profile: AnalysisProfileCommitment;
    readonly operation: AnalysisOperation;
    readonly parameters: Readonly<Record<string, JsonValue>>;
    readonly execution: AnalysisExecution;
  }): string | undefined {
    const refused = executionReplayRefusal(input.execution);
    if (refused !== undefined) return refused;
    if (this.#hasCapacity() || !this.matches(input.target, input.profile))
      return undefined;
    const queryId = analysisQueryId(
      this.#target ?? snapshotTarget(input.target),
      this.#binding ?? snapshotBinding(input.profile),
      input.operation,
      input.parameters,
    );
    return this.#entries.has(queryId)
      ? undefined
      : `the snapshot already holds its ${String(SNAPSHOT_CACHE_ENTRY_CEILING)}-entry maximum`;
  }

  /** Forget all target-bound entries. */
  clear(): void {
    this.#clearEntries();
    this.#target = undefined;
    this.#binding = undefined;
  }

  #clearEntries(): void {
    this.#entries.clear();
    this.#replayBindings.clear();
    this.#workflowEntries.clear();
    this.#imported = false;
  }

  #hasCapacity(): boolean {
    return (
      this.#entries.size + this.#workflowEntries.size <
      SNAPSHOT_CACHE_ENTRY_CEILING
    );
  }
}
