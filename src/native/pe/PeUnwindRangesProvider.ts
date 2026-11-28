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
import type { PeUnwindRangesPort } from "../../ports/binaryDiagnostics/PeUnwindRangesPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import {
  MAX_INSPECT_PE_UNWIND_FILE_BYTES,
  peUnwindEntryLimit,
  type InspectPeUnwindRangesInput,
  type PeUnwindRanges,
} from "../../domain/native/peUnwindRanges.js";
import { err, ok } from "../../domain/result.js";
import { PE_UNWIND_RANGES_PROVIDER } from "../../domain/investigationProviders.js";
import {
  parsePeUnwindRangesFromHandle,
  PE_UNWIND_ENTRY_LIMIT,
} from "./PeUnwindRangesParser.js";

const OPERATION = "inspect_pe_unwind_ranges";
const PE_HEADER_PREFIX_BYTES = 4096;

/** Portable x64 exception-directory reader over one bounded, identity-checked regular file. */
export class PeUnwindRangesProvider implements PeUnwindRangesPort {
  readonly identity = PE_UNWIND_RANGES_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      PE_UNWIND_RANGES_PROVIDER,
      OPERATION,
    );
  }

  async inspect(input: InspectPeUnwindRangesInput, options?: ExecutionOptions) {
    let observed:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    // A verified report stays with a failure raised by final cleanup.
    let completed: PeUnwindRanges | undefined;
    try {
      return await this.#resources.run(async () => {
        const report = await withStableArtifactHandle<PeUnwindRanges>(
          input.path,
          PE_FILE_CEILING_BYTES,
          {
            readBudget: maxFileBytesReadBudget(
              input.max_file_bytes,
              MAX_INSPECT_PE_UNWIND_FILE_BYTES,
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
            const report = await parsePeUnwindRangesFromHandle(
              handle,
              { path: input.path, sha256: handle.sha256, bytes: handle.size },
              input,
              options?.signal,
            );
            assertArtifactReadActive(options?.signal);
            return report;
          },
        );
        return ok(report);
      });
    } catch (cause) {
      const failure = projectPeBinaryFailure<typeof PE_UNWIND_ENTRY_LIMIT>(
        cause,
        input,
        {
          operation: OPERATION,
          providerId: PE_UNWIND_RANGES_PROVIDER.id,
          fileCeiling: {
            name: "The PE whole-file ceiling (32-bit file offsets)",
            bytes: PE_FILE_CEILING_BYTES,
          },
          limits: [PE_UNWIND_ENTRY_LIMIT],
          limitRecovery: (_limit, failure) => {
            const { required } = failure.failure.limit;
            return {
              retryable: false,
              limit: {
                ...peUnwindEntryLimit(failure.maximum_bytes),
                ...(typeof required === "number"
                  ? { required_value: required }
                  : {}),
              },
            };
          },
          ...(completed === undefined ? {} : { completed }),
        },
        observed,
      );
      return err(failure);
    }
  }
}
