import {
  maxFileBytesReadBudget,
  PE_FILE_CEILING_BYTES,
} from "../../domain/artifactReadBudget.js";
import { projectPeBinaryFailure } from "./PeBinaryFailure.js";
import {
  closeArtifactResources,
  withStableArtifactHandle,
  assertArtifactReadActive,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { PeImportsPort } from "../../ports/binaryDiagnostics/PeImportsPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  MAX_INSPECT_PE_IMPORT_FILE_BYTES,
  peImportBudgetLimit,
  type InspectPeImportsInput,
  type PeImportBudget,
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

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      PE_IMPORTS_PROVIDER,
      OPERATION,
    );
  }

  async inspect(input: InspectPeImportsInput, options?: ExecutionOptions) {
    let observed:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () => {
        const report = await withStableArtifactHandle(
          input.path,
          PE_FILE_CEILING_BYTES,
          {
            readBudget: maxFileBytesReadBudget(
              input.max_file_bytes,
              MAX_INSPECT_PE_IMPORT_FILE_BYTES,
            ),
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

/** The control of each parser allowance; running counts know only the budget. */
const IMPORT_CONTROLS = {
  dlls: "max_dlls",
  functions: "max_functions",
  retained_text: "max_text_bytes",
} as const satisfies Record<PeImportLimit, PeImportBudget>;

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
      fileCeiling: {
        name: "The PE whole-file ceiling (32-bit file offsets)",
        bytes: PE_FILE_CEILING_BYTES,
      },
      limits: PE_IMPORT_LIMITS,
      limitRecovery: (limit, failure) => ({
        retryable: false,
        limit: peImportBudgetLimit(
          IMPORT_CONTROLS[limit],
          failure.maximum_bytes,
        ),
      }),
    },
    observed,
  );
