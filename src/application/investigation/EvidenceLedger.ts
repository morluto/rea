import { InvalidResidualUnknownGraphError } from "../../domain/residualUnknownGraphError.js";
import { z } from "zod";

import {
  createEvidenceBundle,
  createImmutableEvidenceBundle,
  isImmutableEvidenceBundle,
  safeParseImmutableEvidenceBundle,
  validateResidualUnknownAddition,
  type EvidenceBundle,
} from "../../domain/evidenceBundle.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { UnknownRegistryError } from "../../domain/unknownRegistryError.js";
import { isImmutableEvidence, type Evidence } from "../../domain/evidence.js";
import { freezeJsonSnapshot } from "../../domain/immutableJson.js";
import { safeParseImmutableEvidence } from "../../domain/evidenceValidation.js";
import {
  createResidualUnknown,
  updateResidualUnknown,
  type RecordUnknownInput,
  type ResidualUnknown,
  type UnknownStatus,
  type UpdateUnknownInput,
} from "../../domain/residualUnknown.js";
import { err, ok, type Result } from "../../domain/result.js";
import { compareUnicodeCodePoints } from "../../domain/unicodeCodePointOrder.js";
import type {
  InvestigationStatistics,
  UnknownPage,
  UnknownQuery,
} from "./InvestigationRecordPort.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  admitInvestigationAuthentication,
  admitInvestigationRetention,
  investigationMaximumRepresentationBytes,
  investigationValueBytes,
  type InvestigationRetentionPolicy,
} from "./InvestigationRetention.js";

type RecordResult = Result<"added" | "duplicate", AnalysisError>;

/** Same authenticated semantic identity with new local display/request metadata. */
export interface EvidenceMetadataReplacement {
  readonly kind: "metadata";
  readonly previous: Evidence;
  readonly current: Evidence;
}

/** Committed changes made by one atomic bundle import. */
export interface EvidenceImportDelta {
  readonly recordsAdded: number;
  readonly unknownsAdded: number;
  readonly changed: boolean;
  readonly replacements: readonly EvidenceMetadataReplacement[];
}

type ImportResult = Result<EvidenceImportDelta, AnalysisError>;
interface RetentionChanges {
  readonly deltaBytes: number;
  readonly recordBytes: ReadonlyMap<string, number>;
}

/** Bounded immutable facts owned by an investigation or a task-local workflow. */
export class EvidenceLedger {
  #records = new Map<string, Evidence>();
  #unknownRevisions = new Map<string, ResidualUnknown>();
  #unknownHeads = new Map<string, ResidualUnknown>();
  #retainedBytes = 0;
  #recordBytes = new Map<string, number>();
  readonly #maximumBytes: number;
  constructor(
    private readonly retentionPolicy: InvestigationRetentionPolicy = {},
  ) {
    this.#maximumBytes =
      investigationMaximumRepresentationBytes(retentionPolicy);
  }

  /** Read committed counts without constructing or hashing a bundle. */
  statistics(): InvestigationStatistics {
    return {
      evidenceRecords: this.#records.size,
      unknownRevisions: this.#unknownRevisions.size,
      unknownHeads: this.#unknownHeads.size,
      retainedRepresentationBytes: this.#retainedBytes,
      maximumRepresentationBytes: this.#maximumBytes,
    };
  }

  /** Record evidence idempotently; conflicting content is rejected. */
  record(input: Evidence): RecordResult {
    const authenticated = this.#readEvidence(
      input,
      "Evidence record validation failed",
    );
    if (!authenticated.ok) return authenticated;
    const evidence = authenticated.value;
    const existing = this.#records.get(evidence.evidence_id);
    if (existing !== undefined) {
      // Both records were authenticated and sealed at ingestion. Their exact
      // semantic IDs establish identity even when local display paths differ;
      // serializing both complete payloads again adds no integrity proof.
      return ok("duplicate");
    }
    const admitted = this.#admitChanges(
      "record_evidence",
      new Map([[evidence.evidence_id, evidence]]),
    );
    if (!admitted.ok)
      return err(this.#exposeRefusedEvidence(admitted.error, evidence));
    this.#records.set(evidence.evidence_id, evidence);
    this.#commitAccounting(admitted.value);
    return ok("added");
  }

  /** Validate an entire bundle before atomically merging its records. */
  import(input: unknown): ImportResult {
    if (!isImmutableEvidenceBundle(input)) {
      const headroom = admitInvestigationAuthentication(
        input,
        "import_evidence_bundle",
        this.retentionPolicy,
      );
      if (!headroom.ok) return headroom;
    }
    const parsed = safeParseImmutableEvidenceBundle(input);
    if (!parsed.ok) {
      const { kind, message, cause } = parsed.error;
      if (kind === "single-record")
        return err(
          new AnalysisInputError("import_evidence_bundle", {
            cause,
            userMessage: message,
          }),
        );
      return err(
        new EvidenceIntegrityError("Evidence bundle validation failed", {
          cause,
          userMessage: message,
        }),
      );
    }
    const bundle = parsed.value;
    // Incoming identities were authenticated above. Stage display replacements
    // once; Unknown history additionally requires validating the merged graph.
    const recordChanges = new Map<string, Evidence>();
    let recordsAdded = 0;
    const replacements: EvidenceMetadataReplacement[] = [];
    for (const evidence of bundle.records) {
      const existing = this.#records.get(evidence.evidence_id);
      if (existing === undefined) {
        recordChanges.set(evidence.evidence_id, evidence);
        recordsAdded += 1;
        continue;
      }
      if (existing === evidence) continue;
      if (!displayMetadataAgree(existing, evidence)) {
        recordChanges.set(evidence.evidence_id, evidence);
        replacements.push({
          kind: "metadata",
          previous: existing,
          current: evidence,
        });
      }
    }
    // A record-only bundle cannot change the already-valid unknown graph.
    if (bundle.unknowns.length === 0) {
      const admitted = this.#admitChanges(
        "import_evidence_bundle",
        recordChanges,
      );
      if (!admitted.ok) return admitted;
      for (const evidence of recordChanges.values())
        this.#records.set(evidence.evidence_id, evidence);
      this.#commitAccounting(admitted.value);
      return ok({
        recordsAdded,
        unknownsAdded: 0,
        changed: recordChanges.size > 0,
        replacements,
      });
    }
    const unknownChanges = new Map<string, ResidualUnknown>();
    let unknownsAdded = 0;
    for (const unknown of bundle.unknowns) {
      const key = unknownRevisionKey(unknown);
      const existing = this.#unknownRevisions.get(key);
      if (
        existing !== undefined &&
        existing.revision_digest !== unknown.revision_digest
      )
        return err(
          new EvidenceIntegrityError("Conflicting unknown revision", {
            userMessage:
              "The incoming residual-unknown history conflicts with a revision retained in this session. Inspect each history in a separate session; importing the unchanged bundle into this session cannot reconcile them.",
            diagnostics: {
              unknown_id: unknown.unknown_id,
              revision: unknown.revision,
            },
          }),
        );
      if (existing === undefined) {
        unknownChanges.set(key, unknown);
        unknownsAdded += 1;
      }
    }
    if (recordChanges.size === 0 && unknownChanges.size === 0)
      return ok({
        recordsAdded: 0,
        unknownsAdded: 0,
        changed: false,
        replacements: [],
      });
    const admitted = this.#admitChanges(
      "import_evidence_bundle",
      recordChanges,
      [...unknownChanges.values()],
    );
    if (!admitted.ok) return admitted;
    const pending = new Map(this.#records);
    for (const evidence of recordChanges.values())
      pending.set(evidence.evidence_id, evidence);
    const pendingUnknowns = new Map(this.#unknownRevisions);
    for (const [key, unknown] of unknownChanges)
      pendingUnknowns.set(key, unknown);
    const checked = this.#validateCandidate(pending, pendingUnknowns);
    if (!checked.ok) {
      if (!(checked.error instanceof UnknownRegistryError)) return checked;
      return err(
        new EvidenceIntegrityError("Evidence bundle unknown registry failed", {
          cause: checked.error,
        }),
      );
    }
    this.#commit(checked.value);
    this.#commitAccounting(admitted.value);
    return ok({
      recordsAdded,
      unknownsAdded,
      changed: recordChanges.size > 0 || unknownsAdded > 0,
      replacements,
    });
  }

  /** Export records in deterministic, semantically irrelevant ID order. */
  export(): EvidenceBundle {
    return structuredClone(
      createEvidenceBundle(
        [...this.#records.values()],
        [...this.#unknownRevisions.values()],
      ),
    );
  }

  /** Borrow an authenticated immutable bundle without copying its records. */
  immutableBundle(): EvidenceBundle {
    return createImmutableEvidenceBundle(
      [...this.#records.values()],
      [...this.#unknownRevisions.values()],
    );
  }

  /** Borrow immutable source records without constructing or hashing a bundle. */
  recordsForAnalysis(): readonly Evidence[] {
    return [...this.#records.values()];
  }

  /** Check whether one immutable Evidence ID is present in this ledger. */
  has(evidenceId: string): boolean {
    return this.#records.has(evidenceId);
  }

  /** Return a detached immutable Evidence value by semantic ID. */
  get(evidenceId: string): Evidence | undefined {
    const evidence = this.#records.get(evidenceId);
    return evidence === undefined ? undefined : structuredClone(evidence);
  }

  /** Borrow authenticated immutable Evidence for read-only analysis without a full clone. */
  forAnalysis(evidenceId: string): Evidence | undefined {
    return this.#records.get(evidenceId);
  }

  /** Create one approved unknown and atomically append its mutation evidence. */
  recordUnknown(
    input: RecordUnknownInput,
    mutationEvidence: Evidence,
  ): Result<ResidualUnknown, AnalysisError> {
    const headroom = admitInvestigationAuthentication(
      input,
      "record_unknown",
      this.retentionPolicy,
    );
    if (!headroom.ok) return headroom;
    const authenticated = this.#readEvidence(
      mutationEvidence,
      "Unknown mutation evidence is invalid",
      "record_unknown",
    );
    if (!authenticated.ok) return authenticated;
    const parsedMutation = authenticated.value;
    let unknown: ResidualUnknown;
    try {
      unknown = createResidualUnknown(
        input,
        parsedMutation.evidence_id,
        parsedMutation.subject?.digest.sha256 ?? null,
      );
    } catch (cause: unknown) {
      if (!(cause instanceof z.ZodError)) throw cause;
      return err(
        analysisInputErrorFromIssues("record_unknown", cause.issues, input, {
          cause,
        }),
      );
    }
    if (this.#unknownHeads.has(unknown.unknown_id))
      return err(new UnknownRegistryError("already-exists"));
    return this.#appendUnknown(unknown, parsedMutation);
  }

  /** Atomically record derived Evidence and a linked residual unknown. */
  recordWithUnknown(
    evidenceInput: Evidence,
    input: RecordUnknownInput,
    mutationInput: Evidence,
  ): Result<ResidualUnknown | null, AnalysisError> {
    const headroom = admitInvestigationAuthentication(
      input,
      "record_unknown",
      this.retentionPolicy,
    );
    if (!headroom.ok) return headroom;
    const authenticatedEvidence = this.#readEvidence(
      evidenceInput,
      "Atomic Evidence validation failed",
    );
    if (!authenticatedEvidence.ok) return authenticatedEvidence;
    const authenticatedMutation = this.#readEvidence(
      mutationInput,
      "Atomic Evidence validation failed",
      "record_unknown",
    );
    if (!authenticatedMutation.ok) return authenticatedMutation;
    const evidence = authenticatedEvidence.value;
    const mutation = authenticatedMutation.value;
    let unknown: ResidualUnknown;
    try {
      unknown = createResidualUnknown(
        input,
        mutation.evidence_id,
        mutation.subject?.digest.sha256 ?? null,
      );
    } catch (cause: unknown) {
      if (!(cause instanceof z.ZodError)) throw cause;
      return err(new UnknownRegistryError("invalid-transition", { cause }));
    }
    const creationUnknown = this.#unknownRevisions.get(
      unknownRevisionKey(unknown),
    );
    if (creationUnknown !== undefined) {
      if (creationUnknown.revision_digest !== unknown.revision_digest)
        return err(new UnknownRegistryError("already-exists"));
      const checked = this.#appendIncremental([evidence]);
      if (!checked.ok)
        return err(this.#exposeRefusedEvidence(checked.error, evidence));
      return ok(null);
    }
    const checked = this.#appendIncremental([evidence, mutation], unknown);
    if (!checked.ok)
      return err(this.#exposeRefusedEvidence(checked.error, evidence));
    return ok(structuredClone(unknown));
  }

  /** Report authenticated completed Evidence without inferring membership from this attempt. */
  #exposeRefusedEvidence(
    error: AnalysisError,
    evidence: Evidence,
  ): AnalysisError {
    if (
      !(error instanceof AnalysisResourceConstraintError) ||
      error.resource !== "capacity"
    )
      return error;
    return error.retainPartialObservation(
      freezeJsonSnapshot(
        this.#records.has(evidence.evidence_id)
          ? {
              kind: "retained-evidence" as const,
              evidence_id: evidence.evidence_id,
            }
          : { kind: "unretained-evidence" as const, evidence },
      ),
    );
  }

  /** Apply one approved full-state update using optimistic revision matching. */
  updateUnknown(
    input: UpdateUnknownInput,
    mutationEvidence: Evidence,
  ): Result<ResidualUnknown, AnalysisError> {
    const current = this.#unknownHeads.get(input.unknown_id);
    if (current === undefined)
      return err(new UnknownRegistryError("not-found"));
    if (current.revision !== input.expected_revision)
      return err(new UnknownRegistryError("revision-conflict"));
    const headroom = admitInvestigationAuthentication(
      input,
      "update_unknown",
      this.retentionPolicy,
    );
    if (!headroom.ok) return headroom;
    let unknown: ResidualUnknown;
    try {
      unknown = updateResidualUnknown(
        current,
        input,
        mutationEvidence.evidence_id,
      );
    } catch (cause: unknown) {
      if (!(cause instanceof z.ZodError)) throw cause;
      return err(
        analysisInputErrorFromIssues("update_unknown", cause.issues, input, {
          cause,
        }),
      );
    }
    const authenticated = this.#readEvidence(
      mutationEvidence,
      "Unknown mutation evidence is invalid",
      "update_unknown",
    );
    if (!authenticated.ok) return authenticated;
    return this.#appendUnknown(unknown, authenticated.value);
  }

  /** Query current heads in stable ID order. */
  listUnknowns(
    filters: {
      readonly status?: UnknownStatus;
      readonly severity?: ResidualUnknown["severity"];
      readonly domain?: string;
    } = {},
  ): ResidualUnknown[] {
    return this.listUnknownsPage(filters).items;
  }

  /** Select a stable page of current heads before detaching record payloads. */
  listUnknownsPage(query: UnknownQuery = {}): UnknownPage {
    const offset = query.offset ?? 0;
    const matching = [...this.#unknownHeads.values()]
      .filter(
        (unknown) =>
          (query.status === undefined || unknown.status === query.status) &&
          (query.severity === undefined ||
            unknown.severity === query.severity) &&
          (query.domain === undefined || unknown.domain === query.domain),
      )
      .sort((left, right) =>
        compareUnicodeCodePoints(left.unknown_id, right.unknown_id),
      );
    const start = Math.min(offset, matching.length);
    const end =
      query.limit === undefined
        ? undefined
        : start + Math.min(query.limit, matching.length - start);
    const page = matching.slice(start, end);
    const nextOffset =
      offset <= matching.length && start + page.length < matching.length
        ? start + page.length
        : null;
    return {
      items: page.map((unknown) => structuredClone(unknown)),
      total: matching.length,
      offset,
      next_offset: nextOffset,
    };
  }

  /** Return current resolution validity; imported invalid states are rejected. */
  verifyUnknownResolution(unknownId: string): Result<
    {
      readonly valid: boolean;
      readonly truthVerified: boolean;
      readonly unknown: ResidualUnknown;
    },
    UnknownRegistryError
  > {
    const unknown = this.#unknownHeads.get(unknownId);
    if (unknown === undefined)
      return err(new UnknownRegistryError("not-found"));
    return ok({
      valid: unknown.status === "resolved",
      truthVerified: unknown.resolution?.disposition === "verified",
      unknown: structuredClone(unknown),
    });
  }

  /** Explicit reset/disposal releases records and accounting; the ceiling stays stable. */
  clear(): void {
    this.#records.clear();
    this.#unknownRevisions.clear();
    this.#unknownHeads.clear();
    this.#retainedBytes = 0;
    this.#recordBytes.clear();
  }

  #appendUnknown(
    unknown: ResidualUnknown,
    mutationEvidence: Evidence,
  ): Result<ResidualUnknown, AnalysisError> {
    const checked = this.#appendIncremental([mutationEvidence], unknown);
    if (!checked.ok) return checked;
    return ok(structuredClone(unknown));
  }

  /** Incoming records were authenticated and sealed at the ingestion boundary. */
  #appendIncremental(
    records: readonly Evidence[],
    unknown?: ResidualUnknown,
  ): Result<void, AnalysisError> {
    const additions = new Map<string, Evidence>();
    for (const evidence of records) {
      const existing =
        additions.get(evidence.evidence_id) ??
        this.#records.get(evidence.evidence_id);
      if (existing !== undefined) {
        continue;
      }
      additions.set(evidence.evidence_id, evidence);
    }
    const unknownKey =
      unknown === undefined ? undefined : unknownRevisionKey(unknown);
    if (unknownKey !== undefined && this.#unknownRevisions.has(unknownKey))
      return err(new UnknownRegistryError("integrity"));
    if (unknown !== undefined)
      try {
        validateResidualUnknownAddition(
          unknown,
          {
            get: (id) => additions.get(id) ?? this.#records.get(id),
            has: (id) => additions.has(id) || this.#records.has(id),
          },
          this.#unknownHeads,
        );
      } catch (cause: unknown) {
        if (!(cause instanceof InvalidResidualUnknownGraphError)) throw cause;
        return err(new UnknownRegistryError(cause.constraint, { cause }));
      }
    const admitted = this.#admitChanges(
      unknown === undefined ? "record_evidence" : mutationOperation(unknown),
      additions,
      unknown === undefined ? [] : [unknown],
    );
    if (!admitted.ok) return admitted;
    for (const [id, evidence] of additions) this.#records.set(id, evidence);
    if (unknown !== undefined && unknownKey !== undefined) {
      this.#unknownRevisions.set(unknownKey, unknown);
      this.#unknownHeads.set(unknown.unknown_id, unknown);
    }
    this.#commitAccounting(admitted.value);
    return ok(undefined);
  }

  /** Return the sealed candidate facts that the commit will adopt. */
  #validateCandidate(
    records: ReadonlyMap<string, Evidence>,
    unknowns: ReadonlyMap<string, ResidualUnknown>,
  ): Result<EvidenceBundle, AnalysisError> {
    // Evidence records borrow their immutable authentication proof. The bundle
    // owner still parses the merged Unknown history into a new sealed snapshot.
    const revisions = [...unknowns.values()];
    const headroom = admitInvestigationAuthentication(
      revisions,
      "import_evidence_bundle",
      this.retentionPolicy,
    );
    if (!headroom.ok) return headroom;
    try {
      return ok(
        createImmutableEvidenceBundle([...records.values()], revisions),
      );
    } catch (cause: unknown) {
      if (
        !(cause instanceof z.ZodError) &&
        !(cause instanceof InvalidResidualUnknownGraphError)
      )
        throw cause;
      return err(
        new UnknownRegistryError(
          cause instanceof InvalidResidualUnknownGraphError
            ? cause.constraint
            : "integrity",
          { cause },
        ),
      );
    }
  }

  #commit(bundle: EvidenceBundle): void {
    const records = new Map(
      bundle.records.map((evidence) => [evidence.evidence_id, evidence]),
    );
    const unknownRevisions = new Map(
      bundle.unknowns.map((unknown) => [unknownRevisionKey(unknown), unknown]),
    );
    const unknownHeads = new Map<string, ResidualUnknown>();
    for (const unknown of bundle.unknowns) {
      const head = unknownHeads.get(unknown.unknown_id);
      if (head === undefined || head.revision < unknown.revision)
        unknownHeads.set(unknown.unknown_id, unknown);
    }
    this.#records = records;
    this.#unknownRevisions = unknownRevisions;
    this.#unknownHeads = unknownHeads;
  }

  #readEvidence(
    input: Evidence,
    message: string,
    operation = "record_evidence",
  ): Result<Evidence, AnalysisError> {
    if (!isImmutableEvidence(input)) {
      const headroom = admitInvestigationAuthentication(
        input,
        operation,
        this.retentionPolicy,
      );
      if (!headroom.ok) return headroom;
    }
    return readLedgerEvidence(input, message);
  }

  /** Stage all byte-index changes; refused inputs never grow owner metadata. */
  #admitChanges(
    operation: string,
    records: ReadonlyMap<string, Evidence>,
    unknowns: readonly ResidualUnknown[] = [],
  ): Result<RetentionChanges, AnalysisError> {
    let delta = 0;
    const recordBytes = new Map<string, number>();
    // Account for every replacement before additions so an atomic shrinking
    // replacement can provide room regardless of incoming bundle order.
    for (const id of records.keys()) {
      const previousBytes = this.#recordBytes.get(id);
      if (previousBytes !== undefined)
        delta -= LEDGER_ENTRY_BYTES + previousBytes;
    }
    for (const record of records.values()) {
      const remaining = this.#maximumBytes - this.#retainedBytes - delta;
      const bytes = investigationValueBytes(
        record,
        remaining - LEDGER_ENTRY_BYTES,
      );
      delta += LEDGER_ENTRY_BYTES + bytes;
      const admitted = admitInvestigationRetention(
        operation,
        this.#retainedBytes,
        delta,
        this.#maximumBytes,
      );
      if (!admitted.ok) return admitted;
      recordBytes.set(record.evidence_id, bytes);
    }
    const newHeads = new Set<string>();
    for (const unknown of unknowns) {
      const key = unknownRevisionKey(unknown);
      const indexBytes = LEDGER_ENTRY_BYTES + 64 + key.length * 2;
      const headBytes =
        this.#unknownHeads.has(unknown.unknown_id) ||
        newHeads.has(unknown.unknown_id)
          ? 0
          : LEDGER_ENTRY_BYTES;
      newHeads.add(unknown.unknown_id);
      const remaining = this.#maximumBytes - this.#retainedBytes - delta;
      delta +=
        indexBytes +
        headBytes +
        investigationValueBytes(unknown, remaining - indexBytes - headBytes);
      const admitted = admitInvestigationRetention(
        operation,
        this.#retainedBytes,
        delta,
        this.#maximumBytes,
      );
      if (!admitted.ok) return admitted;
    }
    return ok({ deltaBytes: delta, recordBytes });
  }

  #commitAccounting(changes: RetentionChanges): void {
    for (const [id, bytes] of changes.recordBytes)
      this.#recordBytes.set(id, bytes);
    this.#retainedBytes += changes.deltaBytes;
  }
}

// Map entries, their key/value references and the owner's committed size index.
// Payloads are charged separately using the shared JSON storage estimator.
const LEDGER_ENTRY_BYTES = 256;
const mutationOperation = (unknown: ResidualUnknown): string =>
  unknown.revision === 1 ? "record_unknown" : "update_unknown";

const readLedgerEvidence = (
  input: unknown,
  message: string,
): Result<Evidence, EvidenceIntegrityError> => {
  const checked = safeParseImmutableEvidence(input);
  return checked.ok
    ? checked
    : err(
        new EvidenceIntegrityError(message, {
          cause: checked.error,
        }),
      );
};

const unknownRevisionKey = (unknown: ResidualUnknown): string =>
  `${unknown.unknown_id}:${String(unknown.revision)}`;

const displayMetadataAgree = (left: Evidence, right: Evidence): boolean =>
  left.subject?.name === right.subject?.name &&
  left.subject?.local_path === right.subject?.local_path &&
  left.caller_input_path === right.caller_input_path;
