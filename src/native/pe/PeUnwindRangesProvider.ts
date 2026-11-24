import { projectPeBinaryFailure } from "./PeBinaryFailure.js";
import {
  projectArtifactCloseFailure,
  imageFileSizeRemediation,
  withStableArtifactHandle,
  assertArtifactReadActive,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { PeUnwindRangesPort } from "../../ports/binaryDiagnostics/PeUnwindRangesPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  MAX_INSPECT_PE_UNWIND_FILE_BYTES,
  type InspectPeUnwindRangesInput,
} from "../../domain/native/peUnwindRanges.js";
import { err, ok } from "../../domain/result.js";
import { PE_UNWIND_RANGES_PROVIDER } from "../../domain/investigationProviders.js";
import { parsePeUnwindRangesFromHandle } from "./PeUnwindRangesParser.js";

const OPERATION = "inspect_pe_unwind_ranges";
const PE_HEADER_PREFIX_BYTES = 4096;

/** Portable x64 exception-directory reader over one bounded, identity-checked regular file. */
export class PeUnwindRangesProvider implements PeUnwindRangesPort {
  readonly identity = PE_UNWIND_RANGES_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        PE_UNWIND_RANGES_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(input: InspectPeUnwindRangesInput, options?: ExecutionOptions) {
    let observed:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () =>
        withStableArtifactHandle(
          input.path,
          input.max_file_bytes,
          {
            retainBytes: (size) => Math.min(size, PE_HEADER_PREFIX_BYTES),
            signal: options?.signal,
            resourceScope: this.#resources,
            onIdentity: (identity) => {
              observed = identity;
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
            return ok(report);
          },
        ),
      );
    } catch (cause) {
      return err(
        projectPeBinaryFailure<never>(
          cause,
          input,
          {
            operation: OPERATION,
            providerId: PE_UNWIND_RANGES_PROVIDER.id,
            fileSizeRemediation: () =>
              imageFileSizeRemediation(
                input.max_file_bytes,
                MAX_INSPECT_PE_UNWIND_FILE_BYTES,
              ),
            limits: [],
            limitRecovery: (_limit, ceiling) =>
              fixedAllowanceOptions(
                "The PE exception-directory entry allowance",
                "parser",
                ceiling,
              ),
          },
          observed,
        ),
      );
    }
  }
}
