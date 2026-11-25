import {
  maxFileBytesReadBudget,
  PE_FILE_CEILING_BYTES,
} from "../../domain/artifactReadBudget.js";
import { projectPeBinaryFailure } from "./PeBinaryFailure.js";
import {
  projectArtifactCloseFailure,
  withStableArtifactHandle,
  assertArtifactReadActive,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { PeLoadConfigPort } from "../../ports/binaryDiagnostics/PeLoadConfigPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { ResourceConstraintRecovery } from "../../domain/analysisErrorCore.js";
import {
  fixedAllowanceOptions,
  type FixedCeilingFacts,
} from "../../domain/fixedAllowanceRemediation.js";
import {
  MAX_INSPECT_PE_LOAD_CONFIG_FILE_BYTES,
  MAX_INSPECT_PE_LOAD_CONFIG_CALLBACKS,
  type InspectPeLoadConfigInput,
} from "../../domain/native/peLoadConfig.js";
import { err, ok } from "../../domain/result.js";
import { PE_LOAD_CONFIG_PROVIDER } from "../../domain/investigationProviders.js";
import {
  parsePeLoadConfigFromHandle,
  PE_LOAD_CONFIG_LIMITS,
  type PeLoadConfigLimit,
} from "./PeLoadConfigParser.js";

const OPERATION = "inspect_pe_load_config";
const PE_HEADER_PREFIX_BYTES = 4096;

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
    let observed:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () =>
        withStableArtifactHandle(
          input.path,
          PE_FILE_CEILING_BYTES,
          {
            readBudget: maxFileBytesReadBudget(
              input.max_file_bytes,
              MAX_INSPECT_PE_LOAD_CONFIG_FILE_BYTES,
            ),
            retainBytes: (size) => Math.min(size, PE_HEADER_PREFIX_BYTES),
            signal: options?.signal,
            resourceScope: this.#resources,
            onIdentity: (identity) => {
              observed = identity;
            },
          },
          async (handle) => {
            assertArtifactReadActive(options?.signal);
            const report = await parsePeLoadConfigFromHandle(
              handle,
              {
                path: input.path,
                sha256: handle.sha256,
                bytes: handle.size,
              },
              input,
              options?.signal,
            );
            assertArtifactReadActive(options?.signal);
            return ok(report);
          },
        ),
      );
    } catch (cause) {
      return err(peLoadConfigFailure(cause, input, observed));
    }
  }
}

const limitRecovery = (
  limit: PeLoadConfigLimit | null,
  input: InspectPeLoadConfigInput,
  ceiling: FixedCeilingFacts,
): ResourceConstraintRecovery =>
  limit === "callbacks"
    ? {
        retryable: false,
        remediationAction:
          input.max_callbacks >= MAX_INSPECT_PE_LOAD_CONFIG_CALLBACKS
            ? `The image exceeds the ${String(MAX_INSPECT_PE_LOAD_CONFIG_CALLBACKS)}-callback ceiling; select a smaller artifact.`
            : `Raise max_callbacks above ${String(input.max_callbacks)} or select a smaller artifact.`,
      }
    : fixedAllowanceOptions(
        "The PE structural decoding allowance",
        "parser",
        ceiling,
      );

const peLoadConfigFailure = (
  cause: unknown,
  input: InspectPeLoadConfigInput,
  observed?: { readonly sha256: string; readonly bytes: number },
): AnalysisError =>
  projectPeBinaryFailure<PeLoadConfigLimit>(
    cause,
    input,
    {
      operation: OPERATION,
      providerId: PE_LOAD_CONFIG_PROVIDER.id,
      fileCeiling: {
        name: "The PE whole-file ceiling (32-bit file offsets)",
        bytes: PE_FILE_CEILING_BYTES,
      },
      limits: PE_LOAD_CONFIG_LIMITS,
      limitRecovery: (limit, ceiling) => limitRecovery(limit, input, ceiling),
    },
    observed,
  );
