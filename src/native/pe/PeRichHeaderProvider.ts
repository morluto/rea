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
import type { PeRichHeaderPort } from "../../ports/binaryDiagnostics/PeRichHeaderPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { ResourceConstraintRecovery } from "../../domain/analysisErrorCore.js";
import type { AnalysisParameterLimit } from "../../domain/analysisSettings.js";
import {
  fixedAllowanceOptions,
  type FixedCeilingFacts,
} from "../../domain/fixedAllowanceRemediation.js";
import {
  DEFAULT_INSPECT_PE_RICH_HEADER_ENTRIES,
  MAX_INSPECT_PE_RICH_HEADER_ENTRIES,
  MAX_INSPECT_PE_RICH_HEADER_FILE_BYTES,
  MIN_INSPECT_PE_RICH_HEADER_ENTRIES,
  type InspectPeRichHeaderInput,
  type PeRichHeader,
} from "../../domain/native/peRichHeader.js";
import { err, ok } from "../../domain/result.js";
import { PE_RICH_HEADER_PROVIDER } from "../../domain/investigationProviders.js";
import {
  parsePeRichHeaderFromHandle,
  PE_RICH_HEADER_ENTRY_ALLOWANCE,
} from "./PeRichHeaderParser.js";

const OPERATION = "inspect_pe_rich_header";
const PE_HEADER_PREFIX_BYTES = 4096;

/** Portable Rich header reader over one bounded, identity-checked regular file. */
export class PeRichHeaderProvider implements PeRichHeaderPort {
  readonly identity = PE_RICH_HEADER_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      PE_RICH_HEADER_PROVIDER,
      OPERATION,
    );
  }

  async inspect(input: InspectPeRichHeaderInput, options?: ExecutionOptions) {
    let observed:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    // A verified report stays with a failure raised by final cleanup.
    let completed: PeRichHeader | undefined;
    try {
      return await this.#resources.run(async () => {
        const report = await withStableArtifactHandle<PeRichHeader>(
          input.path,
          PE_FILE_CEILING_BYTES,
          {
            readBudget: maxFileBytesReadBudget(
              input.max_file_bytes,
              MAX_INSPECT_PE_RICH_HEADER_FILE_BYTES,
            ),
            retainBytes: (size) => Math.min(size, PE_HEADER_PREFIX_BYTES),
            signal: options?.signal,
            resourceScope: this.#resources,
            onIdentity: (identity) => {
              observed = identity;
            },
            onVerifiedResult: (value) => {
              completed = value;
            },
          },
          async (handle) => {
            assertArtifactReadActive(options?.signal);
            const parsed = await parsePeRichHeaderFromHandle(
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
      // The shared PE projection keeps the completed read's file identity.
      return err(
        projectPeBinaryFailure(
          cause,
          input,
          {
            operation: OPERATION,
            providerId: PE_RICH_HEADER_PROVIDER.id,
            fileCeiling: {
              name: "The PE whole-file ceiling (32-bit file offsets)",
              bytes: PE_FILE_CEILING_BYTES,
            },
            limits: [PE_RICH_HEADER_ENTRY_ALLOWANCE],
            limitRecovery: (limit, ceiling) =>
              limitRecovery(limit, input, ceiling),
            ...(completed === undefined ? {} : { completed }),
          },
          observed,
        ),
      );
    }
  }
}

const entryRemediation = (input: InspectPeRichHeaderInput): string =>
  input.max_entries >= MAX_INSPECT_PE_RICH_HEADER_ENTRIES
    ? `The image exceeds the ${String(MAX_INSPECT_PE_RICH_HEADER_ENTRIES)}-entry Rich header ceiling this operation accepts; select a smaller artifact.`
    : `Raise max_entries above ${String(input.max_entries)} or select a smaller artifact; the limit is the caller-selected Rich header entry budget.`;

const entryLimit = (
  input: InspectPeRichHeaderInput,
): AnalysisParameterLimit => ({
  control_kind: "parameter",
  parameter: "max_entries",
  effective_value: input.max_entries,
  unit: "count",
  minimum: MIN_INSPECT_PE_RICH_HEADER_ENTRIES,
  maximum: MAX_INSPECT_PE_RICH_HEADER_ENTRIES,
  default_value: DEFAULT_INSPECT_PE_RICH_HEADER_ENTRIES,
  applies_at: "next_call",
});

/** Recovery for the caller's entry budget, or for the shared PE decoding allowance. */
const limitRecovery = (
  limit: typeof PE_RICH_HEADER_ENTRY_ALLOWANCE | null,
  input: InspectPeRichHeaderInput,
  ceiling: FixedCeilingFacts,
): ResourceConstraintRecovery & { readonly limit?: AnalysisParameterLimit } =>
  limit === PE_RICH_HEADER_ENTRY_ALLOWANCE
    ? {
        retryable: false,
        limit: entryLimit(input),
        remediationAction: entryRemediation(input),
      }
    : fixedAllowanceOptions(
        "The PE structural decoding allowance",
        "parser",
        ceiling,
      );
