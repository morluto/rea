import {
  projectArtifactCloseFailure,
  imageFileSizeRemediation,
} from "../../artifacts/StableArtifactFailure.js";
import {
  type StableArtifactSnapshot,
  readStableArtifact,
} from "../../artifacts/readStableArtifact.js";
import {
  assertArtifactReadActive,
  bindArtifactFileCleanup,
} from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { completedStableArtifactObservation } from "../../artifacts/StableArtifactObservation.js";
import { primaryAnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisResourceConstraintError,
  type ResourceConstraintRecovery,
} from "../../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  MAX_INSPECT_PE_RICH_HEADER_ENTRIES,
  MAX_INSPECT_PE_RICH_HEADER_FILE_BYTES,
  type InspectPeRichHeaderInput,
} from "../../domain/native/peRichHeader.js";
import { parseFailureAnalysisError } from "../../domain/parseFailureAnalysisError.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok } from "../../domain/result.js";
import { PE_RICH_HEADER_PROVIDER } from "../../domain/investigationProviders.js";
import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "../../providers/classifyProviderFailure.js";
import { BinaryResourceFailure } from "../metadata/BinaryContainer.js";
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
    } catch (cause: unknown) {
      const failure = classifyProviderFailure(cause, failureDialect(input));
      // The read completed before decoding failed or was cancelled; keep the
      // exact file identity it established.
      const observation = completedStableArtifactObservation(
        cause,
        input.path,
        snapshot,
      );
      if (observation !== undefined)
        failure.retainPartialObservation(observation);
      return err(failure);
    }
  }
}

/** What this reader adds to the shared classification of its failures. */
const failureDialect = (
  input: InspectPeRichHeaderInput,
): ProviderFailureDialect => ({
  providerId: PE_RICH_HEADER_PROVIDER.id,
  operation: OPERATION,
  // Parser refusals, before the shared facts about the selected file.
  recognise: (raised, details) =>
    raised instanceof BinaryResourceFailure
      ? new AnalysisResourceConstraintError(
          OPERATION,
          "capacity",
          `Selected artifact ${input.path}: ${raised.message}`,
          {
            boundary: raised.boundary,
            maximum: raised.maximum_bytes,
            limit:
              raised instanceof PeRichHeaderEntryLimitFailure
                ? "entries"
                : null,
          },
          { ...details, cause: raised, ...limitRecovery(raised, input) },
        )
      : parseFailureAnalysisError(OPERATION, input.path, raised),
  file: {
    path: input.path,
    description: "image",
    fileSize: (read, details) =>
      new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        read.message,
        { max_file_bytes: input.max_file_bytes },
        {
          ...details,
          retryable: false,
          remediationAction: imageFileSizeRemediation(
            input.max_file_bytes,
            MAX_INSPECT_PE_RICH_HEADER_FILE_BYTES,
          ),
        },
      ),
  },
  readCleanup: (read, primary) => {
    const cleanup = new ProviderCleanupError(
      PE_RICH_HEADER_PROVIDER.id,
      read.cleanup.resources,
      { reason: read.cleanup.reason },
      { operation: OPERATION, cause: read },
    );
    if (primary === undefined) {
      bindArtifactFileCleanup(read, cleanup);
      return cleanup;
    }
    // A nested read reports its own cleanup failure first. Keep the physical
    // primary under this read's cleanup, so nesting adds no envelope.
    const error = analysisErrorWithCleanupFailure(
      primaryAnalysisError(primary),
      cleanup,
      OPERATION,
    );
    bindArtifactFileCleanup(read, error);
    return error;
  },
  unclassified: (raised, details) =>
    new ProviderAdapterError(PE_RICH_HEADER_PROVIDER.id, OPERATION, {
      ...details,
      cause: raised,
      diagnostics: {
        path: input.path,
        reason: raised instanceof Error ? raised.message : String(raised),
      },
    }),
});

const entryRemediation = (input: InspectPeRichHeaderInput): string =>
  input.max_entries >= MAX_INSPECT_PE_RICH_HEADER_ENTRIES
    ? `The image exceeds the ${String(MAX_INSPECT_PE_RICH_HEADER_ENTRIES)}-entry Rich header ceiling this operation accepts; select a smaller artifact.`
    : `Raise max_entries above ${String(input.max_entries)} or select a smaller artifact; the limit is the caller-selected Rich header entry budget.`;

/** Recovery for the caller's entry budget, or for the shared PE decoding allowance. */
const limitRecovery = (
  failure: BinaryResourceFailure,
  input: InspectPeRichHeaderInput,
): ResourceConstraintRecovery =>
  failure instanceof PeRichHeaderEntryLimitFailure
    ? { retryable: false, remediationAction: entryRemediation(input) }
    : fixedAllowanceOptions("The PE structural decoding allowance", "parser");
