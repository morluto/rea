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
import {
  MAX_INSPECT_PE_RICH_HEADER_FILE_BYTES,
  peRichHeaderEntryLimit,
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
            limitRecovery: (_limit, failure) => {
              const { required } = failure.failure.limit;
              return {
                retryable: false,
                limit: {
                  ...peRichHeaderEntryLimit(failure.maximum_bytes),
                  ...(typeof required === "number"
                    ? { required_value: required }
                    : {}),
                },
              };
            },
            ...(completed === undefined ? {} : { completed }),
          },
          observed,
        ),
      );
    }
  }
}
