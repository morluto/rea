import { hasDosMzMagic } from "../../domain/dosMz.js";
import {
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import {
  imageFileSizeRemediation,
  projectOwnedArtifactIdentityFailure,
  projectSelectedArtifactFileFailure,
  stableArtifactInputFailure,
  projectStableArtifactFailure,
  projectArtifactCloseFailure,
  ArtifactReaderFailure,
  withStableArtifactHandle,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  assertArtifactReadActive,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { BinaryHardeningPort } from "../../ports/binaryDiagnostics/BinaryHardeningPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  BINARY_HARDENING_LIMITATIONS,
  MAX_INSPECT_BINARY_HARDENING_FILE_BYTES,
  type BinaryHardening,
  type InspectBinaryHardeningInput,
} from "../../domain/native/binaryHardening.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { err, ok } from "../../domain/result.js";
import { BINARY_HARDENING_PROVIDER } from "../../domain/investigationProviders.js";
import {
  BinaryResourceFailure,
  binaryResourceCeiling,
} from "../../domain/binaryContainer.js";
import {
  readElfHardening,
  readElfHardeningFromHandle,
} from "./ElfHardening.js";
import {
  readMachoHardening,
  readMachoHardeningFromHandle,
} from "./MachoHardening.js";
import { readPeHardening, readPeHardeningFromHandle } from "./PeHardening.js";
import { errorMessage } from "../../kernel/errorMessage.js";

const OPERATION = "inspect_binary_hardening";
const HEADER_PREFIX_BYTES = 4096;

/** Portable ELF, PE, and Mach-O hardening reader over one stable regular file. */
export class BinaryHardeningProvider implements BinaryHardeningPort {
  readonly identity = BINARY_HARDENING_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        BINARY_HARDENING_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(
    input: InspectBinaryHardeningInput,
    options?: ExecutionOptions,
  ) {
    let snapshot:
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
              snapshot = identity;
            },
          },
          async (handle) => {
            assertArtifactReadActive(options?.signal);
            const source = {
              size: handle.size,
              prefix: handle.prefix,
              readRange: (offset: number, length: number) =>
                handle.readRange(offset, length),
            };
            const artifact = {
              path: input.path,
              sha256: handle.sha256,
              bytes: handle.size,
            };
            if (
              handle.prefix.length >= 4 &&
              handle.prefix[0] === 0x7f &&
              handle.prefix[1] === 0x45 &&
              handle.prefix[2] === 0x4c &&
              handle.prefix[3] === 0x46
            )
              return {
                artifact,
                format: "elf" as const,
                images: [
                  await readElfHardeningFromHandle(source, options?.signal),
                ],
                limitations: [...BINARY_HARDENING_LIMITATIONS],
              };
            if (hasDosMzMagic(handle.prefix))
              return {
                artifact,
                format: "pe" as const,
                images: [
                  await readPeHardeningFromHandle(
                    source,
                    artifact,
                    options?.signal,
                  ),
                ],
                limitations: [...BINARY_HARDENING_LIMITATIONS],
              };
            return {
              artifact,
              format: "mach-o" as const,
              images: await readMachoHardeningFromHandle(
                source,
                options?.signal,
              ),
              limitations: [...BINARY_HARDENING_LIMITATIONS],
            };
          },
        );
        assertArtifactReadActive(options?.signal);
        return ok(report);
      });
    } catch (cause) {
      return err(binaryHardeningFailure(cause, input, snapshot));
    }
  }
}

/** Dispatch one stable buffer to the ELF, PE, or Mach-O hardening reader. */
export const readBinaryHardening = async (
  bytes: Buffer,
  artifact: BinaryHardening["artifact"],
  signal?: AbortSignal,
): Promise<BinaryHardening> => {
  assertArtifactReadActive(signal);
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  )
    return {
      artifact,
      format: "elf",
      images: [readElfHardening(bytes, signal)],
      limitations: [...BINARY_HARDENING_LIMITATIONS],
    };
  if (hasDosMzMagic(bytes))
    return {
      artifact,
      format: "pe",
      images: [await readPeHardening(bytes, artifact, signal)],
      limitations: [...BINARY_HARDENING_LIMITATIONS],
    };
  return {
    artifact,
    format: "mach-o",
    images: await readMachoHardening(bytes, signal),
    limitations: [...BINARY_HARDENING_LIMITATIONS],
  };
};

const binaryHardeningFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectBinaryHardeningInput,
): AnalysisError => {
  const { cause, origin } = facts;
  if (origin === "owned-or-classified" && cause instanceof AnalysisError)
    return cause;
  const identityFailure = projectOwnedArtifactIdentityFailure(
    facts,
    OPERATION,
    input.path,
  );
  if (identityFailure !== undefined) return identityFailure;
  if (cause instanceof BinaryResourceFailure)
    return parseLimitConstraint(OPERATION, "capacity", cause, {
      path: input.path,
      ...fixedAllowanceOptions(
        "The binary hardening structural allowance",
        "parser",
        binaryResourceCeiling(cause),
      ),
    });
  const formatFailure = parseFailureAnalysisError(OPERATION, input.path, cause);
  if (formatFailure !== undefined) return formatFailure;
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        cause.message,
        { max_file_bytes: input.max_file_bytes },
        {
          cause,
          retryable: false,
          remediationAction: imageFileSizeRemediation(
            input.max_file_bytes,
            MAX_INSPECT_BINARY_HARDENING_FILE_BYTES,
          ),
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return stableArtifactInputFailure(cause, OPERATION);
  }
  const fileFailure = projectSelectedArtifactFileFailure(
    cause,
    OPERATION,
    input.path,
    "image",
  );
  if (fileFailure !== undefined) return fileFailure;
  return new ProviderAdapterError(BINARY_HARDENING_PROVIDER.id, OPERATION, {
    cause,
    diagnostics: {
      path: input.path,
      reason: errorMessage(cause),
    },
  });
};

const binaryHardeningFailure = (
  cause: unknown,
  input: InspectBinaryHardeningInput,
  snapshot?: { readonly sha256: string; readonly bytes: number },
): AnalysisError =>
  projectStableArtifactFailure(
    cause,
    binaryHardeningFailurePrimary(artifactFilePrimaryFacts(cause), input),
    input.path,
    BINARY_HARDENING_PROVIDER.id,
    OPERATION,
    snapshot,
  );
