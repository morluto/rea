import { projectPeBinaryFailure } from "./PeBinaryFailure.js";
import { projectArtifactCloseFailure } from "../../artifacts/StableArtifactFailure.js";
import {
  type StableArtifactSnapshot,
  readStableArtifact,
} from "../../artifacts/readStableArtifact.js";
import { assertArtifactReadActive } from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { PeLoadConfigPort } from "../../application/binaryDiagnostics/PeLoadConfigPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { ResourceConstraintRecovery } from "../../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  MAX_INSPECT_PE_LOAD_CONFIG_FILE_BYTES,
  MAX_INSPECT_PE_LOAD_CONFIG_CALLBACKS,
  type InspectPeLoadConfigInput,
} from "../../domain/native/peLoadConfig.js";
import { err, ok } from "../../domain/result.js";
import { PE_LOAD_CONFIG_PROVIDER } from "../../domain/investigationProviders.js";
import {
  parsePeLoadConfig,
  PeLoadConfigLimitFailure,
  type PeLoadConfigLimit,
} from "./PeLoadConfigParser.js";

const OPERATION = "inspect_pe_load_config";

/** Portable TLS/load-config reader over one bounded, identity-checked regular file. */
export class PeLoadConfigProvider implements PeLoadConfigPort {
  readonly identity = PE_LOAD_CONFIG_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        PE_LOAD_CONFIG_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(input: InspectPeLoadConfigInput, options?: ExecutionOptions) {
    let snapshot: StableArtifactSnapshot | undefined;
    try {
      return await this.#resources.run(async () => {
        snapshot = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        assertArtifactReadActive(options?.signal);
        const report = await parsePeLoadConfig(
          snapshot.bytes,
          {
            path: input.path,
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          },
          input,
          options?.signal,
        );
        assertArtifactReadActive(options?.signal);
        return ok(report);
      });
    } catch (cause) {
      return err(peLoadConfigFailure(cause, input, snapshot));
    }
  }
}

const fileSizeRemediation = (input: InspectPeLoadConfigInput): string =>
  input.max_file_bytes >= MAX_INSPECT_PE_LOAD_CONFIG_FILE_BYTES
    ? `The image exceeds the ${String(MAX_INSPECT_PE_LOAD_CONFIG_FILE_BYTES)}-byte input ceiling this operation accepts. This release has no runtime override. Select a smaller artifact.`
    : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`;

const limitRecovery = (
  limit: PeLoadConfigLimit | null,
  input: InspectPeLoadConfigInput,
): ResourceConstraintRecovery =>
  limit === "callbacks"
    ? {
        retryable: false,
        remediationAction:
          input.max_callbacks >= MAX_INSPECT_PE_LOAD_CONFIG_CALLBACKS
            ? `The image exceeds the ${String(MAX_INSPECT_PE_LOAD_CONFIG_CALLBACKS)}-callback ceiling; select a smaller artifact.`
            : `Raise max_callbacks above ${String(input.max_callbacks)} or select a smaller artifact.`,
      }
    : fixedAllowanceOptions("The PE structural decoding allowance", "parser");

const peLoadConfigFailure = (
  cause: unknown,
  input: InspectPeLoadConfigInput,
  snapshot?: StableArtifactSnapshot,
): AnalysisError =>
  projectPeBinaryFailure<PeLoadConfigLimit>(
    cause,
    input,
    {
      operation: OPERATION,
      providerId: PE_LOAD_CONFIG_PROVIDER.id,
      fileSizeRemediation: () => fileSizeRemediation(input),
      limit: (failure) =>
        failure instanceof PeLoadConfigLimitFailure ? failure.limit : null,
      limitRecovery: (limit) => limitRecovery(limit, input),
    },
    snapshot,
  );
