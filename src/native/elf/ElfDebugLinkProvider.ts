import {
  isParseLimit,
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import { decodeLimit } from "../../domain/parseFailure.js";
import {
  projectArtifactCloseFailure,
  projectOwnedArtifactIdentityFailure,
  projectSelectedArtifactFileFailure,
  projectStableArtifactFailure,
  stableArtifactInputFailure,
  ArtifactReaderFailure,
  completedStableArtifactStream,
  readStableArtifact,
  streamStableArtifact,
  type StableArtifactSnapshot,
  type StableArtifactStream,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { ElfDebugLinkPort } from "../../ports/binaryDiagnostics/ElfDebugLinkPort.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  ELF_DEBUG_LINK_CANDIDATE_INCOMPLETE_LIMITATION,
  MAX_ELF_DEBUG_CANDIDATE_BYTES,
  MAX_INSPECT_ELF_DEBUG_LINK_ENTRIES,
  MAX_INSPECT_ELF_DEBUG_LINK_FILE_BYTES,
  type ElfDebugLink,
  type InspectElfDebugLinkInput,
} from "../../domain/native/elfDebugLink.js";
import { err, ok } from "../../domain/result.js";
import type { AnalysisPartialObservation } from "../../domain/analysisErrorBase.js";
import { ELF_DEBUG_LINK_PROVIDER } from "../../domain/investigationProviders.js";
import {
  binaryResourceCeiling,
  BinaryResourceFailure,
} from "../../domain/binaryContainer.js";
import {
  continueGnuDebuglinkCrc32,
  parseElfDebugLink,
  unreadableElfDebugCandidate,
  verifyElfDebugCandidate,
} from "./ElfDebugLink.js";
import { ELF_NOTE_TEXT_ALLOWANCE } from "./ElfNoteParser.js";
import { elfSectionNameBudget } from "../../domain/native/elfSectionNameTable.js";

const OPERATION = "inspect_elf_debug_link";

type SelectedField = "path" | "candidate_path";

/** Portable parser over one bounded ELF and an optional caller-selected candidate. */
export class ElfDebugLinkProvider implements ElfDebugLinkPort {
  readonly identity = ELF_DEBUG_LINK_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        ELF_DEBUG_LINK_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(input: InspectElfDebugLinkInput, options?: ExecutionOptions) {
    let field: SelectedField = "path";
    let candidatePhase: CandidatePhase | undefined;
    let crc32 = 0;
    let snapshot: StableArtifactSnapshot | undefined;
    try {
      return await this.#resources.run(async () => {
        field = "path";
        snapshot = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        const image = parseElfDebugLink(
          snapshot.bytes,
          {
            path: input.path,
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          },
          input,
        );
        if (input.candidate_path === undefined) return ok(image);
        field = "candidate_path";
        candidatePhase = { report: image, path: input.candidate_path };
        let candidate;
        try {
          // Stream the whole candidate for the debuglink CRC32 and SHA-256.
          // Only a file within max_file_bytes is retained for ELF decoding;
          // a larger one keeps just its ELF header.
          candidate = await streamStableArtifact(
            input.candidate_path,
            MAX_ELF_DEBUG_CANDIDATE_BYTES,
            {
              retainBytes: (size) =>
                size <= input.max_file_bytes ? size : ELF_HEADER_PREFIX_BYTES,
              onChunk: (chunk) => {
                crc32 = continueGnuDebuglinkCrc32(crc32, chunk);
              },
              signal: options?.signal,
              resourceScope: this.#resources,
            },
          );
        } catch (cause) {
          if (!candidateUnreadable(cause)) throw cause;
          return ok(unreadableElfDebugCandidate(image));
        }
        return ok(verifiedCandidate(candidatePhase, candidate, crc32, input));
      });
    } catch (cause) {
      return err(
        elfDebugLinkFailure(
          cause,
          input,
          field,
          candidatePhase === undefined
            ? { imageSnapshot: snapshot }
            : {
                retained: candidatePhaseObservation(
                  candidatePhase,
                  cause,
                  crc32,
                  input,
                ),
              },
        ),
      );
    }
  }
}

type CandidatePhase = { readonly report: ElfDebugLink; readonly path: string };

const verifiedCandidate = (
  phase: CandidatePhase,
  candidate: StableArtifactStream,
  crc32: number,
  input: InspectElfDebugLinkInput,
): ElfDebugLink =>
  verifyElfDebugCandidate(
    phase.report,
    {
      path: phase.path,
      sha256: candidate.sha256,
      bytes: candidate.size,
      crc32,
      prefix: candidate.prefix,
    },
    input,
  );

/**
 * The decoded image survives a failed candidate phase. A candidate stream that
 * completed before cancellation or a failed close keeps its full comparison;
 * otherwise only the image linkage is retained, without any comparison.
 */
const candidatePhaseObservation = (
  phase: CandidatePhase,
  cause: unknown,
  crc32: number,
  input: InspectElfDebugLinkInput,
): AnalysisPartialObservation => {
  const completed = completedStableArtifactStream(cause);
  return completed === undefined
    ? {
        ...phase.report,
        limitations: [
          ...phase.report.limitations,
          ELF_DEBUG_LINK_CANDIDATE_INCOMPLETE_LIMITATION,
        ],
      }
    : verifiedCandidate(phase, completed, crc32, input);
};

/** Enough retained bytes for an ELF32 or ELF64 fixed header. */
const ELF_HEADER_PREFIX_BYTES = 64;

/**
 * A candidate that is missing, unreadable, fails a data read, changed while
 * streamed, or is above the whole-file ceiling cannot be compared. Path-shape refusals, cancellation,
 * and descriptor close failures, including a close that failed after an
 * integrity or limit refusal, still fail the call.
 */
const candidateUnreadable = (cause: unknown): boolean => {
  // A failed close keeps the original reason beside the cleanup observation;
  // it must stay a failure so the pending handle remains visible.
  if (cause instanceof ArtifactReaderFailure)
    return (
      cause.cleanup === undefined &&
      (cause.reason === "integrity" || cause.reason === "limit")
    );
  if (!(cause instanceof Error) || !("code" in cause)) return false;
  return (
    cause.code === "ENOENT" ||
    cause.code === "ENOTDIR" ||
    cause.code === "EACCES" ||
    cause.code === "EPERM" ||
    cause.code === "EIO"
  );
};

const inputLabel = (field: SelectedField): string =>
  field === "candidate_path" ? "candidate" : "image";

const inputBudgetRemediation = (
  boundary: "file-size" | "capacity",
  input: InspectElfDebugLinkInput,
  field: SelectedField,
): string => {
  const label = inputLabel(field);
  return boundary === "file-size"
    ? input.max_file_bytes >= MAX_INSPECT_ELF_DEBUG_LINK_FILE_BYTES
      ? `The ${label} exceeds the ${String(MAX_INSPECT_ELF_DEBUG_LINK_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller ${label}.`
      : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller ${label}; the limit is the caller-selected input read budget.`
    : input.max_entries >= MAX_INSPECT_ELF_DEBUG_LINK_ENTRIES
      ? `The ${label} exceeds the ${String(MAX_INSPECT_ELF_DEBUG_LINK_ENTRIES)}-entry note-table ceiling this operation accepts; select a smaller ${label}.`
      : `Raise max_entries above ${String(input.max_entries)} or select a smaller ${label}; the limit is the caller-selected note entry budget.`;
};

const sectionNameBudgetRemediation = (
  required: bigint,
  field: SelectedField,
): string => {
  const label = inputLabel(field);
  return required <= BigInt(MAX_INSPECT_ELF_DEBUG_LINK_FILE_BYTES)
    ? `Raise max_file_bytes to at least ${String(required)} bytes to admit the ${label} and its decoded ELF section names.`
    : `The ${label} and its decoded ELF section names require ${String(required)} bytes, above this operation's ${String(MAX_INSPECT_ELF_DEBUG_LINK_FILE_BYTES)}-byte maximum; select a ${label} with a smaller section-name table.`;
};

const selectedPath = (
  input: InspectElfDebugLinkInput,
  field: SelectedField,
): string =>
  field === "candidate_path"
    ? (input.candidate_path ?? input.path)
    : input.path;

const elfDebugLinkFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectElfDebugLinkInput,
  field: SelectedField,
) => {
  const { cause, origin } = facts;
  const path = selectedPath(input, field);
  const sectionNameBudget = elfSectionNameBudget(cause);
  if (isParseLimit(cause, "elf") && sectionNameBudget !== undefined)
    return parseLimitConstraint(OPERATION, "memory", cause, {
      retryable: false,
      remediationAction: sectionNameBudgetRemediation(
        sectionNameBudget.required,
        field,
      ),
    });
  if (cause instanceof BinaryResourceFailure)
    return parseLimitConstraint(
      OPERATION,
      "memory",
      cause,
      fixedAllowanceOptions(
        "The ELF structural decoding allowance",
        "parser",
        binaryResourceCeiling(cause),
      ),
    );
  if (isParseLimit(cause, "elf-notes")) {
    const entryBudget = cause.failure.limit.name === "max_entries";
    return parseLimitConstraint(
      OPERATION,
      entryBudget ? "capacity" : "memory",
      cause,
      entryBudget
        ? {
            retryable: false,
            remediationAction: inputBudgetRemediation("capacity", input, field),
          }
        : fixedAllowanceOptions(ELF_NOTE_TEXT_ALLOWANCE, "parser", {
            limit: cause.failure.limit.maximum,
            unit: "bytes",
          }),
    );
  }
  const formatFailure = parseFailureAnalysisError(
    OPERATION,
    path,
    cause,
    field,
  );
  if (formatFailure !== undefined) return formatFailure;
  const identityFailure = projectOwnedArtifactIdentityFailure(
    facts,
    OPERATION,
    path,
  );
  if (identityFailure !== undefined) return identityFailure;
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit") {
      const candidate = field === "candidate_path";
      return parseLimitConstraint(
        OPERATION,
        "file-size",
        decodeLimit(
          "elf-debug-link",
          cause.message,
          {
            name: candidate ? "candidate_bytes" : "max_file_bytes",
            maximum: candidate
              ? MAX_ELF_DEBUG_CANDIDATE_BYTES
              : input.max_file_bytes,
          },
          { cause },
        ),
        candidate
          ? fixedAllowanceOptions(
              "The whole-file debug candidate read allowance",
              "input",
              {
                limit: MAX_ELF_DEBUG_CANDIDATE_BYTES,
                unit: "bytes",
              },
            )
          : {
              retryable: false,
              remediationAction: inputBudgetRemediation(
                "file-size",
                input,
                field,
              ),
            },
      );
    }
    if (cause.reason === "path" || cause.reason === "format")
      return stableArtifactInputFailure(cause, OPERATION, field);
  }
  const fileFailure = projectSelectedArtifactFileFailure(
    cause,
    OPERATION,
    path,
    field === "candidate_path" ? "debug file candidate" : "ELF image",
    field,
  );
  if (fileFailure !== undefined) return fileFailure;
  return new ArtifactOperationError(
    OPERATION,
    origin === "owned-or-classified" && cause instanceof ArtifactReaderFailure
      ? cause.reason
      : "io",
    undefined,
    cause instanceof Error
      ? cause.message
      : "ELF debug-link inspection failed.",
    { cause },
  );
};

const elfDebugLinkFailure = (
  cause: unknown,
  input: InspectElfDebugLinkInput,
  field: SelectedField,
  {
    retained,
    imageSnapshot,
  }: {
    // The decoded report from a failed candidate phase.
    readonly retained?: AnalysisPartialObservation;
    // A fully read image whose ELF decoding then failed keeps its identity.
    readonly imageSnapshot?: StableArtifactSnapshot | undefined;
  },
) => {
  const primary = elfDebugLinkFailurePrimary(
    artifactFilePrimaryFacts(cause),
    input,
    field,
  );
  // Retained before stable-read projection so the decoded report, which
  // already carries any completed candidate identity, takes precedence.
  if (retained !== undefined) primary.retainPartialObservation(retained);
  return projectStableArtifactFailure(
    cause,
    primary,
    selectedPath(input, field),
    ELF_DEBUG_LINK_PROVIDER.id,
    OPERATION,
    imageSnapshot,
  );
};
