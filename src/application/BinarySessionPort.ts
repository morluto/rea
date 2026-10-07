import type { InvestigationRecordPort } from "./investigation/InvestigationRecordPort.js";
import type { ExecutableFormatHint } from "../domain/dosCom.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { AnalysisSnapshot } from "../domain/analysisSnapshot.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { AnalysisProviderSelector } from "../contracts/providerSelection.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Result } from "../domain/result.js";

import type {
  AnalysisOperation,
  AnalysisOperationPort,
  ExecutionOptions,
  ProviderIdentity,
} from "./AnalysisProvider.js";

/** Target lifecycle used by CLI and MCP without exposing a concrete provider. */
export interface BinarySessionPort
  extends AnalysisOperationPort, InvestigationRecordPort {
  open(
    path: string,
    options?: {
      readonly signal?: AbortSignal;
      readonly targetKind?: BinaryTarget["kind"];
      readonly formatHint?: ExecutableFormatHint;
      readonly snapshot?: AnalysisSnapshot;
      readonly providerId?: AnalysisProviderSelector;
    },
  ): Promise<Result<BinaryTarget, AnalysisError>>;
  close(
    options?: Pick<ExecutionOptions, "progress"> & {
      readonly retainProviderDocuments?: boolean;
    },
  ): Promise<Result<null, AnalysisError>>;
  status(): JsonValue;
  activeTarget(): BinaryTarget | undefined;
  exportAnalysisSnapshot(): Result<AnalysisSnapshot, AnalysisError>;
  importAnalysisSnapshot(
    snapshot: AnalysisSnapshot,
  ): Result<number, AnalysisError>;
  providerIdentity(operation?: AnalysisOperation): ProviderIdentity;
  analysisProfile(
    operation?: AnalysisOperation,
  ): AnalysisProfileCommitment | undefined;
  openCompatibility(): Readonly<Record<string, JsonValue>>;
  onAvailabilityChanged?(listener: () => void | Promise<void>): () => void;
  onAnalysisSnapshotChanged?(listener: () => void | Promise<void>): () => void;
}
