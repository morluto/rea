import { projectPeBinaryFailure } from "./PeBinaryFailure.js";
import {
  projectArtifactCloseFailure,
  imageFileSizeRemediation,
  type StableArtifactSnapshot,
  readStableArtifact,
  assertArtifactReadActive,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { PeRichHeaderPort } from "../../ports/binaryDiagnostics/PeRichHeaderPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { ResourceConstraintRecovery } from "../../domain/analysisErrorCore.js";
import {
  fixedAllowanceOptions,
  type FixedCeilingFacts,
} from "../../domain/fixedAllowanceRemediation.js";
import {
  MAX_INSPECT_PE_RICH_HEADER_ENTRIES,
  MAX_INSPECT_PE_RICH_HEADER_FILE_BYTES,
  type InspectPeRichHeaderInput,
} from "../../domain/native/peRichHeader.js";
import { err, ok } from "../../domain/result.js";
import { PE_RICH_HEADER_PROVIDER } from "../../domain/investigationProviders.js";
import {
  parsePeRichHeader,
  PE_RICH_HEADER_ENTRY_ALLOWANCE,
} from "./PeRichHeaderParser.js";

const OPERATION = "inspect_pe_rich_header";

/** Portable Rich header reader over one bounded, identity-checked regular file. */
export class PeRichHeaderProvider implements PeRichHeaderPort {
  readonly identity = PE_RICH_HEADER_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        PE_RICH_HEADER_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(input: InspectPeRichHeaderInput, options?: ExecutionOptions) {
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
        const report = await parsePeRichHeader(
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
      // The shared PE projection keeps the completed read's file identity.
      return err(
        projectPeBinaryFailure(
          cause,
          input,
          {
            operation: OPERATION,
            providerId: PE_RICH_HEADER_PROVIDER.id,
            fileSizeRemediation: () =>
              imageFileSizeRemediation(
                input.max_file_bytes,
                MAX_INSPECT_PE_RICH_HEADER_FILE_BYTES,
              ),
            limits: [PE_RICH_HEADER_ENTRY_ALLOWANCE],
            limitRecovery: (limit, ceiling) =>
              limitRecovery(limit, input, ceiling),
          },
          snapshot,
        ),
      );
    }
  }
}

const entryRemediation = (input: InspectPeRichHeaderInput): string =>
  input.max_entries >= MAX_INSPECT_PE_RICH_HEADER_ENTRIES
    ? `The image exceeds the ${String(MAX_INSPECT_PE_RICH_HEADER_ENTRIES)}-entry Rich header ceiling this operation accepts; select a smaller artifact.`
    : `Raise max_entries above ${String(input.max_entries)} or select a smaller artifact; the limit is the caller-selected Rich header entry budget.`;

/** Recovery for the caller's entry budget, or for the shared PE decoding allowance. */
const limitRecovery = (
  limit: typeof PE_RICH_HEADER_ENTRY_ALLOWANCE | null,
  input: InspectPeRichHeaderInput,
  ceiling: FixedCeilingFacts,
): ResourceConstraintRecovery =>
  limit === PE_RICH_HEADER_ENTRY_ALLOWANCE
    ? { retryable: false, remediationAction: entryRemediation(input) }
    : fixedAllowanceOptions(
        "The PE structural decoding allowance",
        "parser",
        ceiling,
      );
