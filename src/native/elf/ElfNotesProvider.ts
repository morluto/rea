import {
  isParseLimit,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
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
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  ELF_NOTES_READ_BUDGETS,
  MAX_INSPECT_ELF_NOTE_ENTRIES,
  MAX_INSPECT_ELF_NOTE_FILE_BYTES,
  type ElfNotes,
  type InspectElfNotesInput,
} from "../../domain/native/elfNotes.js";
import { elfReadBudgetLimit } from "../../domain/native/elfReadBudgets.js";
import { err, ok } from "../../domain/result.js";
import { ELF_NOTES_PROVIDER } from "../../domain/investigationProviders.js";
import { elfSectionNameBudget } from "../../domain/native/elfSectionNameTable.js";
import {
  ELF_NOTE_TEXT_ALLOWANCE,
  parseElfNotesFromHandle,
} from "./ElfNoteParser.js";

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

const inputBudgetRemediation = (
  boundary: "file-size" | "capacity",
  input: InspectElfNotesInput,
): string =>
  boundary === "file-size"
    ? input.max_file_bytes >= MAX_INSPECT_ELF_NOTE_FILE_BYTES
      ? `The image exceeds the ${String(MAX_INSPECT_ELF_NOTE_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
      : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`
    : input.max_entries >= MAX_INSPECT_ELF_NOTE_ENTRIES
      ? `The image exceeds the ${String(MAX_INSPECT_ELF_NOTE_ENTRIES)}-entry note-table ceiling this operation accepts; select a smaller artifact.`
      : `Raise max_entries above ${String(input.max_entries)} or select a smaller artifact; the limit is the caller-selected note entry budget.`;

const sectionNameBudgetRemediation = (required: bigint): string =>
  required <= BigInt(MAX_INSPECT_ELF_NOTE_FILE_BYTES)
    ? `Raise max_file_bytes to at least ${String(required)} bytes to admit the source and decoded ELF section names.`
    : `The source and decoded ELF section names require ${String(required)} bytes, above this operation's ${String(MAX_INSPECT_ELF_NOTE_FILE_BYTES)}-byte maximum; select an image with a smaller section-name table.`;

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
      recognise: (failure) => {
        if (failure instanceof ZstandardFrameAllowanceError)
          return projectZstandardFrameAllowance(OPERATION, failure);
        const sectionNameBudget = elfSectionNameBudget(failure);
        if (isParseLimit(failure, "elf") && sectionNameBudget !== undefined)
          return parseLimitConstraint(OPERATION, "memory", failure, {
            retryable: false,
            limit: elfReadBudgetLimit(
              ELF_NOTES_READ_BUDGETS,
              "max_file_bytes",
              input.max_file_bytes,
            ),
            remediationAction: sectionNameBudgetRemediation(
              sectionNameBudget.required,
            ),
          });
        if (isParseLimit(failure, "elf-notes")) {
          const entryBudget = failure.failure.limit.name === "max_entries";
          return parseLimitConstraint(
            OPERATION,
            entryBudget ? "capacity" : "memory",
            failure,
            entryBudget
              ? {
                  retryable: false,
                  limit: elfReadBudgetLimit(
                    ELF_NOTES_READ_BUDGETS,
                    "max_entries",
                    input.max_entries,
                  ),
                  remediationAction: inputBudgetRemediation("capacity", input),
                }
              : fixedAllowanceOptions(ELF_NOTE_TEXT_ALLOWANCE, "parser", {
                  limit: failure.failure.limit.maximum,
                  unit: "bytes",
                }),
          );
        }
        return undefined;
      },
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
            remediationAction: inputBudgetRemediation("file-size", input),
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
