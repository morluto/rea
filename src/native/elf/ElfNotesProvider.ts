import {
  isParseLimit,
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import {
  projectOwnedArtifactIdentityFailure,
  projectSelectedArtifactFileFailure,
  projectStableArtifactFailure,
  stableArtifactInputFailure,
  projectArtifactCloseFailure,
  ArtifactReaderFailure,
  type StableArtifactSnapshot,
  readStableArtifact,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { ElfNotesPort } from "../../ports/binaryDiagnostics/ElfNotesPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { decodeLimit } from "../../domain/parseFailure.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  MAX_INSPECT_ELF_NOTE_ENTRIES,
  MAX_INSPECT_ELF_NOTE_FILE_BYTES,
  type InspectElfNotesInput,
} from "../../domain/native/elfNotes.js";
import { err, ok } from "../../domain/result.js";
import { ELF_NOTES_PROVIDER } from "../../domain/investigationProviders.js";
import {
  ELF_NOTE_TEXT_ALLOWANCE,
  elfNoteSectionNameBudget,
  parseElfNotes,
} from "./ElfNoteParser.js";

const OPERATION = "inspect_elf_notes";

/** Portable parser over one bounded, identity-checked regular file. */
export class ElfNotesProvider implements ElfNotesPort {
  readonly identity = ELF_NOTES_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        ELF_NOTES_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(input: InspectElfNotesInput, options?: ExecutionOptions) {
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
        return ok(
          parseElfNotes(
            snapshot.bytes,
            {
              path: input.path,
              sha256: snapshot.sha256,
              bytes: snapshot.bytes.length,
            },
            input,
          ),
        );
      });
    } catch (cause) {
      return err(elfNotesFailure(cause, input, snapshot));
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

const elfNotesFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectElfNotesInput,
) => {
  const { cause, origin } = facts;
  const sectionNameBudget = elfNoteSectionNameBudget(cause);
  if (isParseLimit(cause, "elf") && sectionNameBudget !== undefined)
    return parseLimitConstraint(OPERATION, "memory", cause, {
      retryable: false,
      remediationAction: sectionNameBudgetRemediation(
        sectionNameBudget.required,
      ),
    });
  if (isParseLimit(cause, "elf-notes")) {
    const entryBudget = cause.failure.limit.name === "max_entries";
    return parseLimitConstraint(
      OPERATION,
      entryBudget ? "capacity" : "memory",
      cause,
      entryBudget
        ? {
            retryable: false,
            remediationAction: inputBudgetRemediation("capacity", input),
          }
        : fixedAllowanceOptions(ELF_NOTE_TEXT_ALLOWANCE, "parser", {
            limit: cause.failure.limit.maximum,
            unit: "bytes",
          }),
    );
  }
  const formatFailure = parseFailureAnalysisError(OPERATION, input.path, cause);
  if (formatFailure !== undefined) return formatFailure;
  const identityFailure = projectOwnedArtifactIdentityFailure(
    facts,
    OPERATION,
    input.path,
  );
  if (identityFailure !== undefined) return identityFailure;
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit")
      return parseLimitConstraint(
        OPERATION,
        "file-size",
        decodeLimit(
          "elf-notes",
          cause.message,
          { name: "max_file_bytes", maximum: input.max_file_bytes },
          { cause },
        ),
        {
          retryable: false,
          remediationAction: inputBudgetRemediation("file-size", input),
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return stableArtifactInputFailure(cause, OPERATION);
  }
  const fileFailure = projectSelectedArtifactFileFailure(
    cause,
    OPERATION,
    input.path,
    "ELF image",
  );
  if (fileFailure !== undefined) return fileFailure;
  return new ArtifactOperationError(
    OPERATION,
    origin === "owned-or-classified" && cause instanceof ArtifactReaderFailure
      ? cause.reason
      : "io",
    undefined,
    cause instanceof Error ? cause.message : "ELF note inspection failed.",
    { cause },
  );
};

const elfNotesFailure = (
  cause: unknown,
  input: InspectElfNotesInput,
  snapshot?: StableArtifactSnapshot,
) => {
  const primary = elfNotesFailurePrimary(
    artifactFilePrimaryFacts(cause),
    input,
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    ELF_NOTES_PROVIDER.id,
    OPERATION,
    snapshot,
  );
};
