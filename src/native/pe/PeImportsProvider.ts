import { projectPeBinaryFailure } from "./PeBinaryFailure.js";
import {
  projectArtifactCloseFailure,
  imageFileSizeRemediation,
  withStableArtifactHandle,
  assertArtifactReadActive,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { PeImportsPort } from "../../ports/binaryDiagnostics/PeImportsPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { ResourceConstraintRecovery } from "../../domain/analysisErrorCore.js";
import {
  fixedAllowanceOptions,
  type FixedCeilingFacts,
} from "../../domain/fixedAllowanceRemediation.js";
import {
  MAX_INSPECT_PE_IMPORT_DLLS,
  MAX_INSPECT_PE_IMPORT_FILE_BYTES,
  MAX_INSPECT_PE_IMPORT_FUNCTIONS,
  MAX_INSPECT_PE_IMPORT_RETAINED_TEXT_BYTES,
  type InspectPeImportsInput,
} from "../../domain/native/peImports.js";
import { err, ok } from "../../domain/result.js";
import { PE_IMPORTS_PROVIDER } from "../../domain/investigationProviders.js";
import {
  parsePeImportsFromHandle,
  PE_IMPORT_LIMITS,
  type PeImportLimit,
} from "./PeImportParser.js";

const OPERATION = "inspect_pe_imports";
const HEADER_PREFIX_BYTES = 4096;

/** Portable import-table reader over one bounded, identity-checked regular file. */
export class PeImportsProvider implements PeImportsPort {
  readonly identity = PE_IMPORTS_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        PE_IMPORTS_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(input: InspectPeImportsInput, options?: ExecutionOptions) {
    let observed:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () => {
        const report = await withStableArtifactHandle(
          input.path,
          input.max_file_bytes,
          {
            signal: options?.signal,
            resourceScope: this.#resources,
            retainBytes: (size) => Math.min(size, HEADER_PREFIX_BYTES),
            onIdentity: (identity) => {
              observed = identity;
            },
          },
          async (handle) => {
            assertArtifactReadActive(options?.signal);
            const parsed = await parsePeImportsFromHandle(
              {
                size: handle.size,
                prefix: handle.prefix,
                readRange: (offset, length) => handle.readRange(offset, length),
              },
              {
                path: input.path,
                sha256: handle.sha256,
                bytes: handle.size,
              },
              input,
              options?.signal,
            );
            assertArtifactReadActive(options?.signal);
            return parsed;
          },
        );
        return ok(report);
      });
    } catch (cause) {
      return err(peImportsFailure(cause, input, observed));
    }
  }
}

const dllRemediation = (input: InspectPeImportsInput): string =>
  input.max_dlls >= MAX_INSPECT_PE_IMPORT_DLLS
    ? `The image exceeds the ${String(MAX_INSPECT_PE_IMPORT_DLLS)}-entry import-descriptor ceiling this operation accepts; select a smaller artifact.`
    : `Raise max_dlls above ${String(input.max_dlls)} or select a smaller artifact; the limit is the caller-selected DLL budget.`;

const functionRemediation = (input: InspectPeImportsInput): string =>
  input.max_functions >= MAX_INSPECT_PE_IMPORT_FUNCTIONS
    ? `The image exceeds the ${String(MAX_INSPECT_PE_IMPORT_FUNCTIONS)}-entry imported-function ceiling this operation accepts; select a smaller artifact.`
    : `Raise max_functions above ${String(input.max_functions)} or select a smaller artifact; the limit is the caller-selected function budget.`;

/** Recovery for one exhausted allowance, chosen from the parser's structured tag. */
const limitRecovery = (
  limit: PeImportLimit | null,
  input: InspectPeImportsInput,
  ceiling: FixedCeilingFacts,
): ResourceConstraintRecovery => {
  switch (limit) {
    case "dlls":
      return { retryable: false, remediationAction: dllRemediation(input) };
    case "functions":
      return {
        retryable: false,
        remediationAction: functionRemediation(input),
      };
    case "retained_text":
      return fixedAllowanceOptions(
        "The PE import retained-text allowance (max_file_bytes, max_dlls and max_functions do not raise it)",
        "bytes",
        { limit: MAX_INSPECT_PE_IMPORT_RETAINED_TEXT_BYTES, unit: "bytes" },
      );
    case null:
      return fixedAllowanceOptions(
        "The PE structural decoding allowance",
        "parser",
        ceiling,
      );
  }
};

const peImportsFailure = (
  cause: unknown,
  input: InspectPeImportsInput,
  observed?: { readonly sha256: string; readonly bytes: number },
): AnalysisError =>
  projectPeBinaryFailure<PeImportLimit>(
    cause,
    input,
    {
      operation: OPERATION,
      providerId: PE_IMPORTS_PROVIDER.id,
      fileSizeRemediation: () =>
        imageFileSizeRemediation(
          input.max_file_bytes,
          MAX_INSPECT_PE_IMPORT_FILE_BYTES,
        ),
      limits: PE_IMPORT_LIMITS,
      limitRecovery: (limit, ceiling) => limitRecovery(limit, input, ceiling),
    },
    observed,
  );
