import { parseLimitConstraint } from "../../domain/parseFailureAnalysisError.js";
import {
  projectStableArtifactFailure,
  closeArtifactResources,
  withStableArtifactHandle,
  yieldArtifactRead,
  artifactFilePrimaryFacts,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { ElfNotesPort } from "../../ports/binaryDiagnostics/ElfNotesPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { decodeLimit } from "../../domain/parseFailure.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";
import {
  projectZstandardFrameAllowance,
  ZstandardFrameAllowanceError,
} from "../../domain/compression/zstandardFrameAllowance.js";
import {
  ELF_NOTES_READ_BUDGETS,
  type ElfNotes,
  type InspectElfNotesInput,
} from "../../domain/native/elfNotes.js";
import { elfReadBudgetLimit } from "../../domain/native/elfReadBudgets.js";
import { err, ok } from "../../domain/result.js";
import { ELF_NOTES_PROVIDER } from "../../domain/investigationProviders.js";
import { elfNoteLimitConstraint } from "./elfNoteLimitConstraint.js";
import { parseElfNotesFromHandle } from "./ElfNoteParser.js";

const OPERATION = "inspect_elf_notes";
const HEADER_PREFIX_BYTES = 4096;

/** Portable parser over one bounded, identity-checked regular file. */
export class ElfNotesProvider implements ElfNotesPort {
  readonly identity = ELF_NOTES_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      ELF_NOTES_PROVIDER,
      OPERATION,
    );
  }

  async inspect(input: InspectElfNotesInput, options?: ExecutionOptions) {
    let completed: ElfNotes | undefined;
    let observed:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () => {
        const result = await withStableArtifactHandle<ElfNotes>(
          input.path,
          input.max_file_bytes,
          {
            signal: options?.signal,
            resourceScope: this.#resources,
            retainBytes: (size) => Math.min(size, HEADER_PREFIX_BYTES),
            onIdentity: (identity) => {
              observed = identity;
            },
            onVerifiedResult: (value) => {
              completed = value;
            },
          },
          (handle) =>
            parseElfNotesFromHandle(
              handle,
              {
                path: input.path,
                sha256: handle.sha256,
                bytes: handle.size,
              },
              input,
              () => yieldArtifactRead(options?.signal),
            ),
        );
        return ok(result);
      });
    } catch (cause) {
      return err(elfNotesFailure(cause, input, observed, completed));
    }
  }
}

const elfNotesFailure = (
  cause: unknown,
  input: InspectElfNotesInput,
  observed?: { readonly sha256: string; readonly bytes: number },
  completed?: ElfNotes,
) => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: ELF_NOTES_PROVIDER.id,
      operation: OPERATION,
      path: input.path,
      description: "ELF image",
      fallbackMessage: "ELF note inspection failed.",
      recognise: (failure) =>
        failure instanceof ZstandardFrameAllowanceError
          ? projectZstandardFrameAllowance(OPERATION, failure)
          : elfNoteLimitConstraint(
              OPERATION,
              failure,
              input,
              ELF_NOTES_READ_BUDGETS,
            ),
      fileSize: (failure) =>
        parseLimitConstraint(
          OPERATION,
          "file-size",
          decodeLimit(
            "elf-notes",
            failure.message,
            { name: "max_file_bytes", maximum: input.max_file_bytes },
            { cause: failure },
          ),
          {
            retryable: false,
            limit: elfReadBudgetLimit(
              ELF_NOTES_READ_BUDGETS,
              "max_file_bytes",
              input.max_file_bytes,
            ),
          },
        ),
    }),
  );
  if (completed !== undefined) primary.retainPartialObservation(completed);
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    ELF_NOTES_PROVIDER.id,
    OPERATION,
    observed,
  );
};
