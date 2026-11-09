import {
  projectStableArtifactFailure,
  projectArtifactCloseFailure,
} from "../../artifacts/StableArtifactFailure.js";
import { isSelectedRegularFileError } from "../../filesystem/RegularFile.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  completedStableArtifactStream,
  readStableArtifact,
  streamStableArtifact,
  type StableArtifactStream,
} from "../../artifacts/readStableArtifact.js";
import {
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  artifactFileCancellationCause,
} from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { ElfDebugLinkPort } from "../../application/binaryDiagnostics/ElfDebugLinkPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
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
import { createElfDebugLinkEvidence } from "../../domain/native/elfDebugLinkEvidence.js";
import { ELF_DEBUG_LINK_PROVIDER } from "../../domain/investigationProviders.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../metadata/BinaryContainer.js";
import {
  continueGnuDebuglinkCrc32,
  parseElfDebugLink,
  unreadableElfDebugCandidate,
  verifyElfDebugCandidate,
} from "./ElfDebugLink.js";
import { ElfNoteSectionNameBudgetFailure } from "./ElfNoteParser.js";

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
    try {
      return await this.#resources.run(async () => {
        field = "path";
        const snapshot = await readStableArtifact(
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
            ? undefined
            : candidatePhaseObservation(
                candidatePhase,
                cause,
                crc32,
                input,
                this.identity,
              ),
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
  provider: typeof ELF_DEBUG_LINK_PROVIDER,
): AnalysisPartialObservation => {
  const completed = completedStableArtifactStream(cause);
  return createElfDebugLinkEvidence(
    completed === undefined
      ? {
          ...phase.report,
          limitations: [
            ...phase.report.limitations,
            ELF_DEBUG_LINK_CANDIDATE_INCOMPLETE_LIMITATION,
          ],
        }
      : verifiedCandidate(phase, completed, crc32, input),
    provider,
    input,
  );
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

const TEXT_BUDGET =
  "The ELF note text, hash, and scan budget fixed by the admitted image length plus decoded section names";

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
  cause: ElfNoteSectionNameBudgetFailure,
  field: SelectedField,
): string => {
  const label = inputLabel(field);
  return cause.minimumMaxFileBytes <=
    BigInt(MAX_INSPECT_ELF_DEBUG_LINK_FILE_BYTES)
    ? `Raise max_file_bytes to at least ${String(cause.minimumMaxFileBytes)} bytes to admit the ${label} and its decoded ELF section names.`
    : `The ${label} and its decoded ELF section names require ${String(cause.minimumMaxFileBytes)} bytes, above this operation's ${String(MAX_INSPECT_ELF_DEBUG_LINK_FILE_BYTES)}-byte maximum; select a ${label} with a smaller section-name table.`;
};

const selectedPath = (
  input: InspectElfDebugLinkInput,
  field: SelectedField,
): string =>
  field === "candidate_path"
    ? (input.candidate_path ?? input.path)
    : input.path;

const readMessage = (
  field: SelectedField,
  path: string,
  code: string,
): string =>
  field === "candidate_path"
    ? `Selected debug file candidate could not be read (${code}): ${path}.`
    : `Selected ELF image could not be read (${code}): ${path}.`;

const elfDebugLinkFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectElfDebugLinkInput,
  field: SelectedField,
) => {
  const { cause, origin } = facts;
  const path = selectedPath(input, field);
  if (cause instanceof ElfNoteSectionNameBudgetFailure)
    return new AnalysisResourceConstraintError(
      OPERATION,
      "memory",
      cause.message,
      {
        max_file_bytes: cause.selectedMaxFileBytes,
        minimum_required_bytes: cause.minimumMaxFileBytes.toString(),
      },
      {
        cause,
        retryable: false,
        remediationAction: sectionNameBudgetRemediation(cause, field),
      },
    );
  if (cause instanceof BinaryResourceFailure)
    return new AnalysisResourceConstraintError(
      OPERATION,
      "memory",
      cause.message,
      { boundary: cause.boundary, maximum_bytes: cause.maximum_bytes },
      {
        cause,
        ...fixedAllowanceOptions(
          "The ELF structural decoding allowance",
          "parser",
        ),
      },
    );
  if (cause instanceof BinaryFormatFailure)
    return cause.kind === "unsupported"
      ? new AnalysisUnsupportedTargetError(OPERATION, path, cause.message, {
          cause,
        })
      : new AnalysisInputError(OPERATION, { cause }, [
          {
            path: [field],
            reason: "invalid_format",
            message: cause.message,
          },
        ]);
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "integrity"
  )
    return new AnalysisArtifactChangedError(OPERATION, path, cause.message, {
      cause,
    });
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "cancelled"
  )
    return new AnalysisCancelledError(OPERATION, {
      cause: artifactFileCancellationCause(cause),
    });
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit") {
      const textBudget = cause.boundary === "memory";
      return new AnalysisResourceConstraintError(
        OPERATION,
        cause.boundary ?? "memory",
        cause.message,
        {
          max_file_bytes: input.max_file_bytes,
          max_entries: input.max_entries,
        },
        {
          cause,
          ...(cause.boundary === undefined
            ? {}
            : textBudget
              ? fixedAllowanceOptions(TEXT_BUDGET, "parser")
              : {
                  retryable: false as const,
                  remediationAction: inputBudgetRemediation(
                    cause.boundary,
                    input,
                    field,
                  ),
                }),
        },
      );
    }
    if (cause.reason === "path" || cause.reason === "format")
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: [field],
          reason: "invalid_format",
          message: cause.message,
        },
      ]);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
        cause,
      });
    if (isSelectedRegularFileError(cause))
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: [field],
          reason: "invalid_value",
          message: readMessage(field, path, String(cause.code)),
        },
      ]);
  }
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
  retained: AnalysisPartialObservation | undefined,
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
  );
};
