import { projectPeBinaryFailure } from "./PeBinaryFailure.js";
import {
  projectArtifactCloseFailure,
  imageFileSizeRemediation,
} from "../../artifacts/StableArtifactFailure.js";
import {
  type StableArtifactSnapshot,
  readStableArtifact,
} from "../../artifacts/readStableArtifact.js";
import { assertArtifactReadActive } from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { ResourceConstraintRecovery } from "../../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  MAX_INSPECT_PE_RICH_HEADER_ENTRIES,
  MAX_INSPECT_PE_RICH_HEADER_FILE_BYTES,
  type InspectPeRichHeaderInput,
} from "../../domain/native/peRichHeader.js";
import { err, ok } from "../../domain/result.js";
import { PE_RICH_HEADER_PROVIDER } from "../../domain/investigationProviders.js";
import {
  parsePeRichHeader,
  PeRichHeaderEntryLimitFailure,
} from "./PeRichHeaderParser.js";

const OPERATION = "inspect_pe_rich_header";

/**
 * Portable Rich header reader over one bounded, identity-checked regular file.
 * It satisfies PeRichHeaderPort structurally; composition checks that where it
 * hands the provider to PeRichHeaderService, so this adapter needs no upward
 * import from the application layer.
 */
export class PeRichHeaderProvider {
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

  async inspect(
    input: InspectPeRichHeaderInput,
    options?: { readonly signal?: AbortSignal },
  ) {
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
      return err(peRichHeaderFailure(cause, input, snapshot));
    }
  }
}

const entryRemediation = (input: InspectPeRichHeaderInput): string =>
  input.max_entries >= MAX_INSPECT_PE_RICH_HEADER_ENTRIES
    ? `The image exceeds the ${String(MAX_INSPECT_PE_RICH_HEADER_ENTRIES)}-entry Rich header ceiling this operation accepts; select a smaller artifact.`
    : `Raise max_entries above ${String(input.max_entries)} or select a smaller artifact; the limit is the caller-selected Rich header entry budget.`;

/** Recovery for the caller's entry budget, or for the shared PE decoding allowance. */
const limitRecovery = (
  limit: "entries" | null,
  input: InspectPeRichHeaderInput,
): ResourceConstraintRecovery =>
  limit === "entries"
    ? { retryable: false, remediationAction: entryRemediation(input) }
    : fixedAllowanceOptions("The PE structural decoding allowance", "parser");

const peRichHeaderFailure = (
  cause: unknown,
  input: InspectPeRichHeaderInput,
  snapshot?: StableArtifactSnapshot,
): AnalysisError =>
  projectPeBinaryFailure<"entries">(
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
      limit: (failure) =>
        failure instanceof PeRichHeaderEntryLimitFailure ? "entries" : null,
      limitRecovery: (limit) => limitRecovery(limit, input),
    },
    snapshot,
  );
