import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Evidence } from "../domain/evidence.js";
import type { EvidenceBundle } from "../domain/evidenceBundle.js";
import type { AnalysisSnapshot } from "../domain/analysisSnapshot.js";
import type {
  AnalysisError,
  EvidenceIntegrityError,
  EvidenceLimitError,
  UnknownRegistryError,
} from "../domain/errors.js";
import type { Result } from "../domain/result.js";
import type {
  RecordUnknownInput,
  ResidualUnknown,
  UnknownStatus,
  UpdateUnknownInput,
} from "../domain/residualUnknown.js";
import type { InvestigationWorkspace } from "../domain/investigationWorkspace.js";
import type {
  AnalysisOperation,
  AnalysisOperationPort,
  ProviderIdentity,
} from "./AnalysisProvider.js";

/** Target lifecycle used by CLI and MCP without exposing a concrete provider. */
export interface BinarySessionPort extends AnalysisOperationPort {
  open(
    path: string,
    options?: {
      readonly signal?: AbortSignal;
      readonly targetKind?: BinaryTarget["kind"];
      readonly snapshot?: AnalysisSnapshot;
    },
  ): Promise<Result<BinaryTarget, AnalysisError>>;
  close(): Promise<Result<null, AnalysisError>>;
  status(): JsonValue;
  activeTarget(): BinaryTarget | undefined;
  recordEvidence(
    evidence: Evidence,
  ): Result<"added" | "duplicate", EvidenceIntegrityError | EvidenceLimitError>;
  hasEvidence(evidenceId: string): boolean;
  evidenceById(evidenceId: string): Evidence | undefined;
  exportEvidenceBundle(): EvidenceBundle;
  importEvidenceBundle(
    bundle: unknown,
  ): Result<number, EvidenceIntegrityError | EvidenceLimitError>;
  exportAnalysisSnapshot(): Result<AnalysisSnapshot, AnalysisError>;
  importAnalysisSnapshot(
    snapshot: AnalysisSnapshot,
  ): Result<number, AnalysisError>;
  retainInvestigationWorkspace(
    workspace: InvestigationWorkspace,
  ): "added" | "duplicate";
  investigationWorkspace(
    workspaceId: string,
    revision: number,
  ): InvestigationWorkspace | undefined;
  investigationWorkspaces(): readonly InvestigationWorkspace[];
  recordUnknown(
    input: RecordUnknownInput,
  ): Result<ResidualUnknown, AnalysisError>;
  recordEvidenceWithUnknown(
    evidence: Evidence,
    input: RecordUnknownInput,
  ): Result<ResidualUnknown | null, AnalysisError>;
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
  providerIdentity(operation?: AnalysisOperation): ProviderIdentity;
  onAvailabilityChanged?(listener: () => void | Promise<void>): () => void;
}
