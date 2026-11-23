import {
  isParseLimit,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import { decodeLimit } from "../../domain/parseFailure.js";
import {
  projectArtifactCloseFailure,
  projectStableArtifactFailure,
  ArtifactReaderFailure,
  completedStableArtifactStream,
  withStableArtifactHandle,
  streamStableArtifact,
  type StableArtifactStream,
  artifactFilePrimaryFacts,
  artifactFileCompletion,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { ElfDebugLinkPort } from "../../ports/binaryDiagnostics/ElfDebugLinkPort.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  ELF_DEBUG_LINK_CANDIDATE_INCOMPLETE_LIMITATION,
  ELF_DEBUG_LINK_CANDIDATE_COMPARISON_INCOMPLETE_LIMITATION,
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
  parseElfDebugLinkFromHandle,
  unreadableElfDebugCandidate,
  verifyElfDebugCandidate,
  verifyElfDebugCandidateCooperative,
  type ElfDebugCandidateFile,
} from "./ElfDebugLink.js";
import { ELF_NOTE_TEXT_ALLOWANCE } from "./ElfNoteParser.js";
import { elfSectionNameBudget } from "../../domain/native/elfSectionNameTable.js";

const OPERATION = "inspect_elf_debug_link";
const HEADER_PREFIX_BYTES = 4096;

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
    let candidate: StableArtifactStream | undefined;
    let crc32 = 0;
    let parsedImage: ElfDebugLink | undefined;
    let observedImage:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () => {
        field = "path";
        const image = await withStableArtifactHandle(
          input.path,
          input.max_file_bytes,
          {
            signal: options?.signal,
            resourceScope: this.#resources,
            retainBytes: (size) => Math.min(size, HEADER_PREFIX_BYTES),
            onIdentity: (identity) => {
              observedImage = identity;
            },
          },
          async (handle) => {
            parsedImage = await parseElfDebugLinkFromHandle(
              {
                size: handle.size,
                prefix: handle.prefix,
                readRange: (offset, length) => handle.readRange(offset, length),
              },
              {
                path: input.path,
                sha256: handle.sha256,
                bytes: handle.size,
              },
              input,
              options?.signal,
            );
            return parsedImage;
          },
        );
        if (input.candidate_path === undefined) return ok(image);
        field = "candidate_path";
        candidatePhase = { report: image, path: input.candidate_path };
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
        return ok(
          await verifiedCandidate(
            candidatePhase,
            candidate,
            crc32,
            input,
            options?.signal,
          ),
        );
      });
    } catch (cause) {
      let retained: AnalysisPartialObservation | undefined;
      if (candidatePhase !== undefined)
        retained = candidatePhaseObservation(
          candidatePhase,
          cause,
          crc32,
          input,
          candidate,
        );
      else if (
        parsedImage !== undefined &&
        artifactFileCompletion(cause)?.value === parsedImage
      ) {
        // Only the file owner can establish that the decoded image passed
        // the final stability check before release was interrupted.
        retained =
          input.candidate_path === undefined
            ? parsedImage
            : incompleteCandidateObservation(parsedImage);
      }
      return err(
        elfDebugLinkFailure(cause, input, field, {
          retained,
          imageSnapshot:
            candidatePhase === undefined ? observedImage : undefined,
        }),
      );
    }
  }
}

type CandidatePhase = { readonly report: ElfDebugLink; readonly path: string };

const candidateFile = (
  phase: CandidatePhase,
  candidate: StableArtifactStream,
  crc32: number,
): ElfDebugCandidateFile => ({
  path: phase.path,
  sha256: candidate.sha256,
  bytes: candidate.size,
  crc32,
  prefix: candidate.prefix,
});

const verifiedCandidate = (
  phase: CandidatePhase,
  candidate: StableArtifactStream,
  crc32: number,
  input: InspectElfDebugLinkInput,
  signal?: AbortSignal,
): Promise<ElfDebugLink> =>
  verifyElfDebugCandidateCooperative(
    phase.report,
    candidateFile(phase, candidate, crc32),
    input,
    signal,
  );

const incompleteCandidateObservation = (
  report: ElfDebugLink,
): ElfDebugLink => ({
  ...report,
  limitations: [
    ...report.limitations,
    ELF_DEBUG_LINK_CANDIDATE_INCOMPLETE_LIMITATION,
  ],
});

const unverifiedCandidateObservation = (
  report: ElfDebugLink,
  candidate: ElfDebugCandidateFile,
): ElfDebugLink => ({
  ...report,
  candidate: {
    path: candidate.path,
    sha256: candidate.sha256,
    bytes: candidate.bytes,
    format: null,
    byte_order: null,
    debug_info: "unknown",
    symtab: "unknown",
  },
  limitations: [
    ...report.limitations,
    ELF_DEBUG_LINK_CANDIDATE_COMPARISON_INCOMPLETE_LIMITATION,
  ],
});

/** Retain the completed stream without restarting an interrupted comparison. */
const candidatePhaseObservation = (
  phase: CandidatePhase,
  cause: unknown,
  crc32: number,
  input: InspectElfDebugLinkInput,
  candidate: StableArtifactStream | undefined,
): AnalysisPartialObservation => {
  if (candidate !== undefined)
    return unverifiedCandidateObservation(
      phase.report,
      candidateFile(phase, candidate, crc32),
    );
  const completed = completedStableArtifactStream(cause);
  if (completed === undefined)
    return incompleteCandidateObservation(phase.report);
  const file = candidateFile(phase, completed, crc32);
  if (artifactFileCompletion(cause)?.cancellation !== undefined)
    return unverifiedCandidateObservation(phase.report, file);
  // A close failure alone can retain a complete comparison.
  try {
    return verifyElfDebugCandidate(phase.report, file, input);
  } catch {
    return unverifiedCandidateObservation(phase.report, file);
  }
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

const elfDebugLinkFailure = (
  cause: unknown,
  input: InspectElfDebugLinkInput,
  field: SelectedField,
  {
    retained,
    imageSnapshot,
  }: {
    // The completed report before image finalization or a candidate failure.
    readonly retained: AnalysisPartialObservation | undefined;
    // A fully read image whose ELF decoding then failed keeps its identity.
    readonly imageSnapshot?:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
  },
) => {
  const path = selectedPath(input, field);
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: ELF_DEBUG_LINK_PROVIDER.id,
      operation: OPERATION,
      path,
      description:
        field === "candidate_path" ? "debug file candidate" : "ELF image",
      field,
      fallbackMessage: "ELF debug-link inspection failed.",
      recognise: (failure) => {
        const sectionNameBudget = elfSectionNameBudget(failure);
        if (isParseLimit(failure, "elf") && sectionNameBudget !== undefined)
          return parseLimitConstraint(OPERATION, "memory", failure, {
            retryable: false,
            remediationAction: sectionNameBudgetRemediation(
              sectionNameBudget.required,
              field,
            ),
          });
        if (failure instanceof BinaryResourceFailure)
          return parseLimitConstraint(
            OPERATION,
            "memory",
            failure,
            fixedAllowanceOptions(
              "The ELF structural decoding allowance",
              "parser",
              binaryResourceCeiling(failure),
            ),
          );
        if (isParseLimit(failure, "elf-notes")) {
          const entryBudget = failure.failure.limit.name === "max_entries";
          return parseLimitConstraint(
            OPERATION,
            entryBudget ? "capacity" : "memory",
            failure,
            entryBudget
              ? {
                  retryable: false,
                  remediationAction: inputBudgetRemediation(
                    "capacity",
                    input,
                    field,
                  ),
                }
              : fixedAllowanceOptions(ELF_NOTE_TEXT_ALLOWANCE, "parser", {
                  limit: failure.failure.limit.maximum,
                  unit: "bytes",
                }),
          );
        }
        return undefined;
      },
      fileSize: (failure) => {
        const candidate = field === "candidate_path";
        return parseLimitConstraint(
          OPERATION,
          "file-size",
          decodeLimit(
            "elf-debug-link",
            failure.message,
            {
              name: candidate ? "candidate_bytes" : "max_file_bytes",
              maximum: candidate
                ? MAX_ELF_DEBUG_CANDIDATE_BYTES
                : input.max_file_bytes,
            },
            { cause: failure },
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
      },
    }),
  );
  // Retained before stable-read projection so the decoded report, which
  // already carries any completed candidate identity, takes precedence.
  if (retained !== undefined) primary.retainPartialObservation(retained);
  return projectStableArtifactFailure(
    cause,
    primary,
    path,
    ELF_DEBUG_LINK_PROVIDER.id,
    OPERATION,
    imageSnapshot,
  );
};
