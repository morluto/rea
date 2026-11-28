import { maxFileBytesReadBudget } from "../../domain/artifactReadBudget.js";
import { parseLimitConstraint } from "../../domain/parseFailureAnalysisError.js";
import {
  artifactFileCeilingConstraint,
  artifactFilePrimaryFacts,
  artifactReadBudgetConstraint,
  assertArtifactReadActive,
  closeArtifactResources,
  projectStableArtifactFailure,
  withStableArtifactHandle,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { MachoFunctionStartsPort } from "../../ports/binaryDiagnostics/MachoFunctionStartsPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";
import {
  BinaryResourceFailure,
  binaryResourceAllowance,
  isNativeStructureFailure,
} from "../../domain/binaryContainer.js";
import { nativeStructureConstraint } from "../../domain/native/nativeStructureBudget.js";
import {
  MACHO_FUNCTION_STARTS_FILE_CEILING_BYTES,
  MAX_INSPECT_MACHO_FUNCTION_STARTS_FILE_BYTES,
  machoFunctionStartsEntryLimit,
  type InspectMachoFunctionStartsInput,
  type MachoFunctionStarts,
} from "../../domain/native/machoFunctionStarts.js";
import { err, ok } from "../../domain/result.js";
import { MACHO_FUNCTION_STARTS_PROVIDER } from "../../domain/investigationProviders.js";
import {
  MACHO_FUNCTION_STARTS_ENTRY_LIMIT,
  parseMachoFunctionStartsFromHandle,
} from "./MachoFunctionStarts.js";

const OPERATION = "inspect_macho_function_starts";
const HEADER_PREFIX_BYTES = 4096;
const FILE_CEILING = {
  name: "The Mach-O whole-file ceiling (32-bit linkedit dataoff and FAT32 offsets)",
  bytes: MACHO_FUNCTION_STARTS_FILE_CEILING_BYTES,
} as const;

/** Portable Mach-O function-start reader over one bounded, identity-checked regular file. */
export class MachoFunctionStartsProvider implements MachoFunctionStartsPort {
  readonly identity = MACHO_FUNCTION_STARTS_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      MACHO_FUNCTION_STARTS_PROVIDER,
      OPERATION,
    );
  }

  async inspect(
    input: InspectMachoFunctionStartsInput,
    options?: ExecutionOptions,
  ) {
    const signal = options?.signal;
    let completed: MachoFunctionStarts | undefined;
    let snapshot:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () => {
        const report = await withStableArtifactHandle<MachoFunctionStarts>(
          input.path,
          FILE_CEILING.bytes,
          {
            readBudget: maxFileBytesReadBudget(
              input.max_file_bytes,
              MAX_INSPECT_MACHO_FUNCTION_STARTS_FILE_BYTES,
            ),
            retainBytes: (size) => Math.min(size, HEADER_PREFIX_BYTES),
            signal,
            resourceScope: this.#resources,
            onIdentity: (identity) => {
              snapshot = identity;
            },
            onVerifiedResult: (value) => {
              completed = value;
            },
          },
          async (handle) => {
            assertArtifactReadActive(signal);
            const value = await parseMachoFunctionStartsFromHandle(
              handle,
              { path: input.path, sha256: handle.sha256, bytes: handle.size },
              input,
              signal,
            );
            assertArtifactReadActive(signal);
            return value;
          },
        );
        return ok(report);
      });
    } catch (cause) {
      return err(machoFunctionStartsFailure(cause, input, snapshot, completed));
    }
  }
}

const machoFunctionStartsFailure = (
  cause: unknown,
  input: InspectMachoFunctionStartsInput,
  snapshot?: { readonly sha256: string; readonly bytes: number },
  completed?: MachoFunctionStarts,
) => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: MACHO_FUNCTION_STARTS_PROVIDER.id,
      operation: OPERATION,
      path: input.path,
      description: "Mach-O image",
      fallbackMessage: "Mach-O function-start inspection failed.",
      recognise: (failure) => {
        const readBudget = artifactReadBudgetConstraint(OPERATION, failure, {
          max_file_bytes: input.max_file_bytes,
        });
        if (readBudget !== undefined) return readBudget;
        if (isNativeStructureFailure(failure))
          return nativeStructureConstraint(OPERATION, failure, input.path);
        if (
          !(failure instanceof BinaryResourceFailure) ||
          binaryResourceAllowance(failure, [
            MACHO_FUNCTION_STARTS_ENTRY_LIMIT,
          ]) === null
        )
          return undefined;
        const { required } = failure.failure.limit;
        return parseLimitConstraint(OPERATION, "capacity", failure, {
          path: input.path,
          retryable: false,
          limit: {
            ...machoFunctionStartsEntryLimit(failure.maximum_bytes),
            ...(typeof required === "number"
              ? { required_value: required }
              : {}),
          },
        });
      },
      fileSize: (failure) =>
        artifactFileCeilingConstraint(OPERATION, failure, FILE_CEILING, {
          max_file_bytes: input.max_file_bytes,
        }),
    }),
  );
  if (completed !== undefined) primary.retainPartialObservation(completed);
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    MACHO_FUNCTION_STARTS_PROVIDER.id,
    OPERATION,
    snapshot,
  );
};
