import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import type { Evidence } from "../../domain/evidence.js";
import type { EvidenceBundle } from "../../domain/evidenceBundle.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { UnknownRegistryError } from "../../domain/unknownRegistryError.js";
import type {
  RecordUnknownInput,
  ResidualUnknown,
  UnknownStatus,
  UpdateUnknownInput,
} from "../../domain/residualUnknown.js";
import type { Result } from "../../domain/result.js";
import { EvidenceLedger, type EvidenceImportDelta } from "./EvidenceLedger.js";
import { unknownMutationEvidence } from "./UnknownEvidence.js";
import type {
  EvidenceReader,
  EvidenceWriter,
  EvidenceUnknownWriter,
  UnknownRegistryPort,
  UnknownPage,
  UnknownQuery,
  InvestigationStatistics,
} from "./InvestigationRecordPort.js";
import {
  admitInvestigationAuthentication,
  type InvestigationRetentionPolicy,
} from "./InvestigationRetention.js";

/** One investigation's validated record owner, independent of binary execution. */
export class InvestigationRecords
  implements
    EvidenceReader,
    EvidenceWriter,
    EvidenceUnknownWriter,
    UnknownRegistryPort
{
  readonly #evidence: EvidenceLedger;

  /** Snapshot a heap-derived representation allowance for this investigation. */
  constructor(
    private readonly retentionPolicy: InvestigationRetentionPolicy = {},
  ) {
    this.#evidence = new EvidenceLedger(retentionPolicy);
  }

  /** O(1) committed state; no bundle construction, cloning or hashing. */
  statistics(): InvestigationStatistics {
    return this.#evidence.statistics();
  }

  /** Check live headroom before constructing a recovery representation. */
  admitRecoveryObservation(
    input: unknown,
    operation: string,
    additional: {
      readonly valueBytes: number;
      readonly serializedUtf16Bytes: number;
    },
  ): Result<void, AnalysisError> {
    return admitInvestigationAuthentication(
      input,
      operation,
      this.retentionPolicy,
      additional,
    );
  }

  /** Record immutable Evidence idempotently; reject conflicting content. */
  recordEvidence(
    evidence: Evidence,
  ): Result<"added" | "duplicate", AnalysisError> {
    return this.#evidence.record(evidence);
  }

  /** Check one semantic Evidence ID without exposing stored values. */
  hasEvidence(evidenceId: string): boolean {
    return this.#evidence.has(evidenceId);
  }

  /** Return a detached Evidence value for one semantic ID. */
  evidenceById(evidenceId: string): Evidence | undefined {
    return this.#evidence.get(evidenceId);
  }

  /** Borrow an immutable authenticated record for a read-only application workflow. */
  evidenceForAnalysis(evidenceId: string): Evidence | undefined {
    return this.#evidence.forAnalysis(evidenceId);
  }

  /** Export a detached deterministic bundle of Evidence and Unknown revisions. */
  exportEvidenceBundle(): EvidenceBundle {
    return this.#evidence.export();
  }

  /** Borrow an authenticated immutable bundle snapshot without copying its records. */
  immutableEvidenceBundle(): EvidenceBundle {
    return this.#evidence.immutableBundle();
  }

  /** Atomically merge a bundle and report changes for the owner's post-commit observers. */
  mergeEvidenceBundle(
    bundle: unknown,
  ): Result<EvidenceImportDelta, AnalysisError> {
    return this.#evidence.import(bundle);
  }

  /** Explicit reset/disposal releases the investigation's durable records. */
  clear(): void {
    this.#evidence.clear();
  }

  /** Record an Unknown with an explicitly supplied Evidence subject, if any. */
  recordUnknown(
    input: RecordUnknownInput,
    target?: BinaryTarget,
  ): Result<ResidualUnknown, AnalysisError> {
    const admitted = admitInvestigationAuthentication(
      input,
      "record_unknown",
      this.retentionPolicy,
    );
    if (!admitted.ok) return admitted;
    return this.#evidence.recordUnknown(
      input,
      unknownMutationEvidence(target, { operation: "record_unknown", input }),
    );
  }

  /** Commit derived Evidence and its Unknown atomically without an implicit subject. */
  recordEvidenceWithUnknown(
    evidence: Evidence,
    input: RecordUnknownInput,
  ): Result<ResidualUnknown | null, AnalysisError> {
    const admitted = admitInvestigationAuthentication(
      input,
      "record_unknown",
      this.retentionPolicy,
    );
    if (!admitted.ok) return admitted;
    return this.#evidence.recordWithUnknown(
      evidence,
      input,
      unknownMutationEvidence(undefined, {
        operation: "record_unknown",
        input,
      }),
    );
  }

  /** Update an optimistic revision with an explicitly supplied Evidence subject. */
  updateUnknown(
    input: UpdateUnknownInput,
    target?: BinaryTarget,
  ): Result<ResidualUnknown, AnalysisError> {
    const admitted = admitInvestigationAuthentication(
      input,
      "update_unknown",
      this.retentionPolicy,
    );
    if (!admitted.ok) return admitted;
    const evidence = unknownMutationEvidence(target, {
      operation: "update_unknown",
      input,
    });
    return this.#evidence.updateUnknown(input, evidence);
  }

  /** Return detached current Unknown revisions matching the selected filters. */
  listUnknowns(
    filters: {
      readonly status?: UnknownStatus;
      readonly severity?: ResidualUnknown["severity"];
      readonly domain?: string;
    } = {},
  ): ResidualUnknown[] {
    return this.#evidence.listUnknowns(filters);
  }

  listUnknownsPage(query: UnknownQuery = {}): UnknownPage {
    return this.#evidence.listUnknownsPage(query);
  }

  /** Verify registry consistency without asserting the answer is true. */
  verifyUnknownResolution(unknownId: string): Result<
    {
      readonly valid: boolean;
      readonly truthVerified: boolean;
      readonly unknown: ResidualUnknown;
    },
    UnknownRegistryError
  > {
    return this.#evidence.verifyUnknownResolution(unknownId);
  }
}
