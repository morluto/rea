import type { Evidence } from "../../domain/evidence.js";
import type { EvidenceBundle } from "../../domain/evidenceBundle.js";
import type { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { UnknownRegistryError } from "../../domain/unknownRegistryError.js";
import type {
  RecordUnknownInput,
  ResidualUnknown,
  UnknownStatus,
  UpdateUnknownInput,
} from "../../domain/residualUnknown.js";
import type { Result } from "../../domain/result.js";

/** Detached investigation Evidence reads without target execution or lifecycle authority. */
export interface EvidenceReader {
  hasEvidence(evidenceId: string): boolean;
  evidenceById(evidenceId: string): Evidence | undefined;
  /** Optional immutable analysis read; older adapters can keep detached reads. */
  evidenceForAnalysis?(evidenceId: string): Evidence | undefined;
  /** Optional immutable bundle snapshot for complete serialization without graph copies. */
  evidenceBundleForSerialization?(): EvidenceBundle;
  exportEvidenceBundle(): EvidenceBundle;
}

/** Idempotent investigation Evidence writes without target execution. */
export interface EvidenceWriter {
  recordEvidence(
    evidence: Evidence,
  ): Result<"added" | "duplicate", EvidenceIntegrityError>;
}

/** Atomic derived Evidence and linked Unknown writes. */
export interface EvidenceUnknownWriter {
  recordEvidenceWithUnknown(
    evidence: Evidence,
    input: RecordUnknownInput,
  ): Result<ResidualUnknown | null, AnalysisError>;
}

/** Optimistic Unknown revisions and consistency verification. */
export interface UnknownRegistryPort {
  recordUnknown(
    input: RecordUnknownInput,
  ): Result<ResidualUnknown, AnalysisError>;
  updateUnknown(
    input: UpdateUnknownInput,
  ): Result<ResidualUnknown, AnalysisError>;
  listUnknowns(filters?: {
    readonly status?: UnknownStatus;
    readonly severity?: ResidualUnknown["severity"];
    readonly domain?: string;
  }): ResidualUnknown[];
  verifyUnknownResolution(unknownId: string): Result<
    {
      readonly valid: boolean;
      readonly truthVerified: boolean;
      readonly unknown: ResidualUnknown;
    },
    UnknownRegistryError
  >;
}

/** Compatibility record surface; binary execution and snapshots remain separate. */
export interface InvestigationRecordPort
  extends
    EvidenceReader,
    EvidenceWriter,
    EvidenceUnknownWriter,
    UnknownRegistryPort {
  importEvidenceBundle(bundle: unknown): Result<number, EvidenceIntegrityError>;
}
