import {
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import { UNREAL_PAK_PROVIDER_IDENTITY } from "./UnrealPakProviderIdentity.js";
import { setImmediate } from "node:timers/promises";
import {
  ArtifactResourceScope,
  ArtifactReaderFailure,
  ArtifactFileCleanupFailure,
  ArtifactFileCancelled,
  bindArtifactFileCleanup,
  assertArtifactReadActive,
  readStableArtifactRanges,
  artifactFilePrimaryFacts,
} from "../resources/index.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import type { UnrealPakPort } from "../ports/unreal/UnrealPakPort.js";
import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import { errorMessage } from "../kernel/errorMessage.js";
import type { ParseFailureError } from "../domain/parseFailure.js";
import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "../providers/classifyProviderFailure.js";
import { createEvidence } from "../domain/evidence.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
  fixedCeilingConstraint,
  occupiedCapacityConstraint,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  unrealPakSchema,
  type UnrealPak,
  type UnrealPakProviderInput,
} from "../domain/unreal/unrealPak.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import {
  readUnrealPak,
  unrealPakFailureFacts,
  type UnrealPakDecoded,
} from "./UnrealPakFile.js";

const OPERATION = "inspect_unreal_pak";
const REGION_BYTES = 256 * 1024 * 1024;
const ENTRIES = 1_000_000;
const OUTPUT_BYTES = 64 * 1024 * 1024;

/** The smallest JSON one entry row can take: null path, one-digit numbers. */
const ENTRY_ROW = JSON.stringify({
  path: null,
  path_hash: null,
  offset: 0,
  size: 0,
  uncompressed_size: 0,
  compression_method: 0,
  compression_name: null,
  compression_blocks: 0,
  compression_block_size: 0,
  encrypted: false,
  deleted: false,
  sha1: null,
  record: "full",
}).length;

const LIMITATIONS = [
  "Only the footer and index of pak versions 1 to 12 are decoded; entry paths, offsets, sizes and compression names are observed index content. File data is not read, decompressed or extracted.",
  "Encrypted indexes are reported as encrypted with their footer facts only; no key is accepted and nothing is decrypted. Version 9 frozen indexes are unsupported.",
  "Compression names come from the footer table (version 8+) or legacy flag values (Zlib, Gzip, Custom); they name methods, not verified codecs. The pak version is not attributed to an engine release.",
];

/** Provider-owned refusals; shared file, cancellation and cleanup facts come from classifyProviderFailure. */
const pakFailureDialect = (
  path: string,
  outputBytes: number,
): ProviderFailureDialect => ({
  providerId: UNREAL_PAK_PROVIDER_IDENTITY.id,
  operation: OPERATION,
  recognise: (cause, details) => {
    // The pak reads no budgeted input bytes; a reader limit is the reader's own ceiling.
    if (cause instanceof ArtifactReaderFailure && cause.reason === "limit")
      return fixedCeilingConstraint(
        OPERATION,
        cause.boundary ?? "file-size",
        cause.message,
        { name: "The artifact reader's fixed read allowance", kind: "bytes" },
        { ...details, cause },
      );
    const pak = unrealPakFailureFacts(cause);
    if (pak === undefined) return undefined;
    const { failure } = pak;
    if (failure.failure.kind === "limit")
      return parseLimitConstraint(
        OPERATION,
        // Path text is report text, so its limit is the output budget.
        pak.reason === "paths-too-large" ? "transport" : "file-size",
        failure as ParseFailureError<"limit">,
        {
          ...details,
          ...(pak.reason === "paths-too-large"
            ? reportAllowance(outputBytes)
            : pak.reason === "too-many-entries"
              ? fixedAllowanceOptions(
                  `The Unreal pak entry allowance of ${String(ENTRIES)} entries (this release has no runtime override)`,
                  "count",
                )
              : fixedAllowanceOptions(
                  `The Unreal pak index-region allowance of ${String(REGION_BYTES)} bytes (this release has no runtime override)`,
                  "bytes",
                )),
        },
      );
    // Unsupported, malformed and truncated pak bytes map like every other
    // format parser's: an unsupported or malformed target refusal.
    return parseFailureAnalysisError(OPERATION, path, failure);
  },
  file: { path, description: "Unreal pak" },
  diagnostics: { path },
  unclassified: (cause, details) =>
    new ProviderAdapterError(UNREAL_PAK_PROVIDER_IDENTITY.id, OPERATION, {
      ...details,
      cause,
      diagnostics: {
        path,
        reason: errorMessage(cause),
      },
    }),
});

/** Path text and issues are report text, so all three share this allowance. */
const reportAllowance = (maximumBytes: number) =>
  fixedAllowanceOptions(
    `The Unreal pak complete-report allowance of ${String(maximumBytes)} bytes (this release has no runtime override)`,
    "report",
  );

const outputLimit = (path: string, maximumBytes: number) =>
  fixedCeilingConstraint(
    OPERATION,
    "transport",
    `Complete pak index for ${path} exceeds the inline output budget; no partial success is returned.`,
    reportAllowance(maximumBytes).fixedAllowance,
  );

type PakArtifact = UnrealPak["artifact"];
type StableRead = { readonly sha256: string; readonly bytes: number };

/** The whole-file read that completed even though its close or cancellation failed. */
const completedRead = (cause: unknown): StableRead | undefined => {
  const outcome =
    cause instanceof ArtifactFileCleanupFailure
      ? (cause as ArtifactFileCleanupFailure<StableRead>).fileCleanupFailure
          .outcome
      : cause instanceof ArtifactFileCancelled
        ? (cause as ArtifactFileCancelled<StableRead>).fileCancellation.outcome
        : undefined;
  return outcome?.kind === "completed" ? outcome.value : undefined;
};

/** Source identity survives a failed inspection without claiming index coverage. */
const pakSourceEvidence = (artifact: PakArtifact) =>
  createEvidence(
    { path: artifact.path, sha256: artifact.sha256, format: "file" },
    UNREAL_PAK_PROVIDER_IDENTITY,
    {
      operation: "observe_unreal_pak_source",
      predicateType: "rea.unreal-pak-source",
      parameters: { path: artifact.path },
      result: { artifact, inventory_status: "not-returned-as-complete" },
      confidence: "observed",
      limitations: [
        "This partial source observation records the hashed file identity only; it does not contain footer, index or entry facts.",
      ],
      locations: [
        { kind: "artifact-path", path: artifact.path },
        { kind: "file-offset-range", start: 0, end: artifact.bytes },
      ],
    },
  );

/** Stable in-process index decoding without extraction, decompression or decryption. */
export class UnrealPakProvider implements UnrealPakPort {
  readonly identity = UNREAL_PAK_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();
  #inspecting = false;

  /** `outputBytes` exists so tests can reach the guard with small files. */
  constructor(
    private readonly outputBytes: number = OUTPUT_BYTES,
    private readonly yieldControl: () => Promise<void> = setImmediate,
  ) {}

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      if (
        !(cause instanceof ArtifactReaderFailure) ||
        cause.cleanup === undefined
      )
        throw cause;
      const error = new ProviderCleanupError(
        UNREAL_PAK_PROVIDER_IDENTITY.id,
        cause.cleanup.resources,
        { reason: cause.cleanup.reason },
        { cause, operation: OPERATION },
      );
      bindArtifactFileCleanup(cause, error);
      throw error;
    }
  }

  /** Read the footer and index of one stable file snapshot and hash the whole file. */
  async inspect(
    input: UnrealPakProviderInput,
    options?: ExecutionOptions,
  ): Promise<Result<UnrealPak, AnalysisError>> {
    if (this.#inspecting)
      return err(
        occupiedCapacityConstraint(
          OPERATION,
          "Only one Unreal pak inspection is admitted per reader.",
          { maximum_concurrent_inspections: 1 },
          "Retry after the active Unreal pak inspection on this reader completes.",
        ),
      );
    this.#inspecting = true;
    let artifact: PakArtifact | undefined;
    try {
      const limit = this.outputBytes;
      const {
        result: decoded,
        sha256,
        bytes,
      } = await this.#resources.run(() =>
        readStableArtifactRanges(
          input.path,
          (source) =>
            readUnrealPak(source, {
              regionBytes: REGION_BYTES,
              entries: ENTRIES,
              pathChars: limit,
              pause: async () => {
                await this.yieldControl();
                assertArtifactReadActive(options?.signal);
              },
              beforeEntries: (count) => {
                if (count * ENTRY_ROW > limit)
                  throw outputLimit(input.path, limit);
              },
              beforeIssues: (issueBytes) => {
                if (issueBytes > limit) throw outputLimit(input.path, limit);
              },
            }),
          options?.signal,
          this.#resources,
        ).catch((cause: unknown) => {
          // Only this awaited stable read owns these typed physical outcomes.
          const read = completedRead(cause);
          if (read !== undefined)
            artifact = {
              path: input.path,
              sha256: read.sha256,
              bytes: read.bytes,
            };
          throw cause;
        }),
      );
      artifact = { path: input.path, sha256, bytes };
      assertArtifactReadActive(options?.signal);
      const report = {
        ...decoded,
        artifact,
        limitations: LIMITATIONS,
      };
      // Counted in UTF-8 bytes without building the serialization the budget would refuse.
      if (jsonValueByteLength(report, limit) > limit)
        throw outputLimit(input.path, limit);
      const parsed = unrealPakSchema.safeParse(report);
      if (!parsed.success)
        throw new AnalysisOutputError(
          OPERATION,
          "Unreal pak reader produced invalid footer, index or entry values.",
          { cause: parsed.error },
        );
      assertArtifactReadActive(options?.signal);
      return ok(parsed.data);
    } catch (cause: unknown) {
      // Classify the failure the file operation reports as primary; an
      // unresolved descriptor cleanup is composed onto it afterwards.
      const primary = artifactFilePrimaryFacts(cause);
      const dialect = pakFailureDialect(input.path, this.outputBytes);
      const classified =
        primary.origin === "owned-or-classified"
          ? classifyProviderFailure(primary.cause, dialect)
          : dialect.unclassified(primary.cause, {});
      const failure =
        cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined
          ? analysisErrorWithCleanupFailure(
              classified,
              new ProviderCleanupError(
                UNREAL_PAK_PROVIDER_IDENTITY.id,
                cause.cleanup.resources,
                { reason: cause.cleanup.reason },
                { operation: OPERATION, cause },
              ),
              OPERATION,
            )
          : classified;
      if (failure !== classified) bindArtifactFileCleanup(cause, failure);
      if (artifact !== undefined && failure.partialObservation === undefined)
        failure.retainPartialObservation(pakSourceEvidence(artifact));
      return err(failure);
    } finally {
      this.#inspecting = false;
    }
  }
}
