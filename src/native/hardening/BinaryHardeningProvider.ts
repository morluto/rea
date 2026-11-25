import { maxFileBytesReadBudget } from "../../domain/artifactReadBudget.js";
import { hasDosMzMagic } from "../../domain/dosMz.js";
import { parseLimitConstraint } from "../../domain/parseFailureAnalysisError.js";
import {
  artifactFileCeilingConstraint,
  artifactReadBudgetConstraint,
  projectStableArtifactFailure,
  closeArtifactResources,
  withStableArtifactHandle,
  artifactFilePrimaryFacts,
  assertArtifactReadActive,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { BinaryHardeningPort } from "../../ports/binaryDiagnostics/BinaryHardeningPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  BINARY_HARDENING_LIMITATIONS,
  MAX_INSPECT_BINARY_HARDENING_FILE_BYTES,
  type InspectBinaryHardeningInput,
} from "../../domain/native/binaryHardening.js";
import { err, ok } from "../../domain/result.js";
import { BINARY_HARDENING_PROVIDER } from "../../domain/investigationProviders.js";
import {
  hasElfMagic,
  BinaryResourceFailure,
  binaryResourceCeiling,
} from "../../domain/binaryContainer.js";
import { readElfHardeningFromHandle } from "./ElfHardening.js";
import { readMachoHardeningFromHandle } from "./MachoHardening.js";
import { readPeHardeningFromHandle } from "./PeHardening.js";

const OPERATION = "inspect_binary_hardening";
const HEADER_PREFIX_BYTES = 4096;

/** Portable ELF, PE, and Mach-O hardening reader over one stable regular file. */
export class BinaryHardeningProvider implements BinaryHardeningPort {
  readonly identity = BINARY_HARDENING_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      BINARY_HARDENING_PROVIDER,
      OPERATION,
    );
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
          MAX_INSPECT_BINARY_HARDENING_FILE_BYTES,
          {
            readBudget: maxFileBytesReadBudget(
              input.max_file_bytes,
              MAX_INSPECT_BINARY_HARDENING_FILE_BYTES,
            ),
            signal: options?.signal,
            resourceScope: this.#resources,
            retainBytes: (size) => Math.min(size, HEADER_PREFIX_BYTES),
            onIdentity: (identity) => {
              snapshot = identity;
            },
          },
          async (handle) => {
            assertArtifactReadActive(options?.signal);
            const artifact = {
              path: input.path,
              sha256: handle.sha256,
              bytes: handle.size,
            };
            if (hasElfMagic(handle.prefix))
              return {
                artifact,
                format: "elf" as const,
                images: [
                  await readElfHardeningFromHandle(handle, options?.signal),
                ],
                limitations: [...BINARY_HARDENING_LIMITATIONS],
              };
            if (hasDosMzMagic(handle.prefix))
              return {
                artifact,
                format: "pe" as const,
                images: [
                  await readPeHardeningFromHandle(
                    handle,
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
                handle,
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

const binaryHardeningFailure = (
  cause: unknown,
  input: InspectBinaryHardeningInput,
  snapshot?: { readonly sha256: string; readonly bytes: number },
): AnalysisError => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: BINARY_HARDENING_PROVIDER.id,
      operation: OPERATION,
      path: input.path,
      description: "image",
      recognise: (failure) =>
        artifactReadBudgetConstraint(OPERATION, failure, {
          max_file_bytes: input.max_file_bytes,
        }) ??
        (failure instanceof BinaryResourceFailure
          ? parseLimitConstraint(OPERATION, "capacity", failure, {
              path: input.path,
              ...fixedAllowanceOptions(
                "The binary hardening structural allowance",
                "parser",
                binaryResourceCeiling(failure),
              ),
            })
          : undefined),
      fileSize: (failure) =>
        artifactFileCeilingConstraint(
          OPERATION,
          failure,
          {
            name: "The binary hardening whole-file ceiling",
            bytes: MAX_INSPECT_BINARY_HARDENING_FILE_BYTES,
          },
          {
            max_file_bytes: input.max_file_bytes,
          },
        ),
    }),
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    BINARY_HARDENING_PROVIDER.id,
    OPERATION,
    snapshot,
  );
};
