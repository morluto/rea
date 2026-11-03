import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { z } from "zod";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import { RAW_BYTES_PROVIDER } from "../../domain/investigationProviders.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisOutputError,
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  formatHexDump,
  inspectRawBytesInputSchema,
  inspectRawBytesSchema,
  searchRawBytesInputSchema,
  searchRawBytesSchema,
  type InspectRawBytes,
  type SearchRawBytes,
} from "../../domain/native/rawBytes.js";
import { err, type Result } from "../../domain/result.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import {
  withArtifactFileHandle,
  bindArtifactFileCleanup,
  ArtifactFileCleanupFailure,
  artifactFileCompletion,
  assertArtifactReadActive,
  artifactFileCancellationCause,
  artifactSelectedPathErrno,
} from "../../artifacts/ArtifactFileOperation.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { sameRegularFileState } from "../../filesystem/RegularFile.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import {
  matchContext,
  scanForPattern,
  type AdmittedFile,
} from "./RawBytesScan.js";

export { RAW_BYTES_SCAN_CHUNK_BYTES } from "./RawBytesScan.js";

const INSPECT = "inspect_raw_bytes";
const SEARCH = "search_raw_bytes";

const SUBJECT_UNAVAILABLE =
  "The whole file is not hashed: only the selected bytes were read, and the observation records the file size at read time.";
const OFFSET_LIMITATION =
  "Offsets are absolute positions in the file on disk, not program memory addresses; a loader-adjusted address from an analyzed program generally differs.";

const invalidInput = (operation: string, field: string, message: string) =>
  new AnalysisInputError(operation, undefined, [
    { path: [field], reason: "invalid_value", message },
  ]);

/** One operation's read: its report plus the Evidence parameters that selected it. */
interface RawBytesObservation<
  Report extends {
    readonly artifact: { readonly path: string };
    readonly limitations: readonly string[];
  },
> {
  readonly operation: string;
  readonly path: string;
  readonly parameters: Record<string, unknown>;
  readonly schema: z.ZodType<Report>;
  readonly read: (admitted: AdmittedFile) => Promise<Report>;
}

/** Offline raw file-offset observations shared by CLI and MCP. */
export class RawBytesService {
  readonly #resources: ArtifactResourceScope;

  constructor(
    private readonly files: Pick<
      typeof import("node:fs/promises"),
      "open" | "stat"
    > = { open, stat },
    resources: ArtifactResourceScope = new ArtifactResourceScope(),
  ) {
    this.#resources = resources;
  }

  /** Return one bounded slice of the file at an absolute offset, with an xxd dump. */
  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return this.#guarded(INSPECT, async () => {
      const parsed = parseAnalysisInput(
        INSPECT,
        rawInput,
        inspectRawBytesInputSchema,
        options?.signal,
      );
      if (!parsed.ok) return parsed;
      const input = parsed.value;
      return this.#observe(
        {
          operation: INSPECT,
          path: input.path,
          parameters: {
            path: input.path,
            offset: input.offset,
            length: input.length,
          },
          schema: inspectRawBytesSchema,
          read: async (admitted): Promise<InspectRawBytes> => {
            const { size, invalid } = admitted;
            if (input.offset > size)
              throw invalid(
                "offset",
                "Selected byte window starts beyond the end of the file.",
              );
            if (input.length > size - input.offset)
              throw invalid(
                "length",
                "Selected byte window extends beyond the end of the file.",
              );
            const bytes = Buffer.alloc(input.length);
            await admitted.readExactly(bytes, 0, input.length, input.offset);
            return {
              artifact: { path: input.path, bytes: size },
              window: { offset: input.offset, length: input.length },
              data_hex: bytes.toString("hex"),
              hex_dump: formatHexDump(bytes, input.offset),
              limitations: [OFFSET_LIMITATION],
            };
          },
        },
        options,
      );
    });
  }

  /** Scan the file in bounded chunks for a masked byte pattern and report file offsets. */
  search(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return this.#guarded(SEARCH, async () => {
      const parsed = parseAnalysisInput(
        SEARCH,
        rawInput,
        searchRawBytesInputSchema,
        options?.signal,
      );
      if (!parsed.ok) return parsed;
      const input = parsed.value;
      return this.#observe(
        {
          operation: SEARCH,
          path: input.path,
          parameters: {
            path: input.path,
            pattern: input.pattern,
            ...(input.mask === undefined ? {} : { mask: input.mask }),
            start_offset: input.start_offset,
            max_matches: input.max_matches,
            context_lines: input.context_lines,
          },
          schema: searchRawBytesSchema,
          read: async (admitted): Promise<SearchRawBytes> => {
            if (input.start_offset > admitted.size)
              throw admitted.invalid(
                "start_offset",
                "Search start lies beyond the end of the file.",
              );
            const found = await scanForPattern(admitted, input);
            const matches: SearchRawBytes["matches"] = [];
            for (const offset of found.offsets)
              matches.push({
                offset,
                context: await matchContext(
                  admitted,
                  offset,
                  found.patternBytes,
                  input.context_lines,
                ),
              });
            return {
              artifact: { path: input.path, bytes: admitted.size },
              pattern_bytes: found.patternBytes,
              start_offset: input.start_offset,
              matches,
              complete: found.nextOffset === null,
              next_offset: found.nextOffset,
              limitations: [
                OFFSET_LIMITATION,
                "Overlapping matches are all reported; a match is reported at the offset of its first byte.",
                ...(found.nextOffset === null
                  ? []
                  : [
                      "The match limit was reached before the end of the file; repeat with start_offset set to next_offset to continue.",
                    ]),
              ],
            };
          },
        },
        options,
      );
    });
  }

  close(): Promise<void> {
    return this.#resources.close();
  }

  async #guarded(
    operation: string,
    run: () => Promise<Result<Evidence, AnalysisError>>,
  ): Promise<Result<Evidence, AnalysisError>> {
    try {
      return await this.#resources.run(run);
    } catch (cause: unknown) {
      const failure = new AnalysisOutputError(
        operation,
        "A retained raw-bytes file descriptor could not be released before inspection.",
        {
          cause,
          ...(cause instanceof ArtifactReaderFailure &&
          cause.cleanup !== undefined
            ? { cleanup: cause.cleanup }
            : {}),
        },
      );
      bindArtifactFileCleanup(cause, failure);
      return err(failure);
    }
  }

  async #observe<
    Report extends {
      readonly artifact: { readonly path: string };
      readonly limitations: readonly string[];
    },
  >(
    observation: RawBytesObservation<Report>,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const { operation, path } = observation;
    if (!isAbsolute(path))
      return err(
        invalidInput(
          operation,
          "path",
          "Expected an absolute filesystem path on this host.",
        ),
      );
    const invalid = (field: string, message: string) =>
      invalidInput(operation, field, message);
    const evidenceFromReport = (report: Report): Evidence =>
      createEvidence(undefined, RAW_BYTES_PROVIDER, {
        operation,
        parameters: observation.parameters,
        result: report,
        rawResult: null,
        confidence: "observed",
        limitations: report.limitations,
        subjectUnavailableReason: SUBJECT_UNAVAILABLE,
        locations: [{ kind: "artifact-path", path }],
      });
    // Cleanup errors erase the callback's generic type. Validate their completed
    // value before publishing it as this operation's observation.
    const completedObservation = (value: unknown): Evidence | undefined => {
      const report = observation.schema.safeParse(value);
      return report.success && report.data.artifact.path === path
        ? evidenceFromReport(report.data)
        : undefined;
    };
    let admitted = false;
    const readFailure = (cause: unknown): AnalysisError => {
      if (cause instanceof AnalysisError) return cause;
      if (cause instanceof Error && "code" in cause) {
        if (cause.code === "EACCES" || cause.code === "EPERM")
          return new AnalysisAccessDeniedError(operation, path, cause.code, {
            cause,
          });
        const pathErrno = artifactSelectedPathErrno(cause);
        if (pathErrno !== undefined)
          return admitted
            ? new AnalysisArtifactChangedError(
                operation,
                path,
                "Selected file path changed during raw byte inspection.",
                { cause },
              )
            : new AnalysisInputError(operation, { cause }, [
                {
                  path: ["path"],
                  reason: "invalid_value",
                  message:
                    pathErrno === "ENOENT" || pathErrno === "ENOTDIR"
                      ? "Selected file could not be found."
                      : pathErrno === "ELOOP"
                        ? `Selected file path could not be resolved because symbolic-link traversal looped or exceeded the host limit (ELOOP): ${path}`
                        : `Selected file path exceeds the host path or component length limit (ENAMETOOLONG): ${path}`,
                },
              ]);
      }
      return new AnalysisOutputError(
        operation,
        cause instanceof ArtifactReaderFailure
          ? cause.message
          : "Could not read complete raw byte evidence.",
        { cause },
      );
    };
    try {
      const before = await this.files.stat(path, { bigint: true });
      if (!before.isFile()) throw invalid("path", "Expected a regular file.");
      admitted = true;
      const handle = await this.files.open(
        path,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      const report = await withArtifactFileHandle(
        path,
        handle,
        this.#resources,
        options?.signal,
        async (file) => {
          const initial = await file.stat({ bigint: true });
          const changed = () =>
            new AnalysisArtifactChangedError(
              operation,
              path,
              "File identity, size or timestamps changed during raw byte inspection.",
            );
          if (!initial.isFile() || !sameRegularFileState(initial, before))
            throw changed();
          const size = Number(initial.size);
          if (!Number.isSafeInteger(size))
            throw invalid(
              "path",
              "File size exceeds exact numeric offset representation.",
            );
          const result = await observation.read({
            file,
            size,
            signal: options?.signal,
            invalid,
            readExactly: async (buffer, bufferOffset, length, position) => {
              let filled = 0;
              while (filled < length) {
                assertArtifactReadActive(options?.signal);
                const { bytesRead } = await file.read(
                  buffer,
                  bufferOffset + filled,
                  length - filled,
                  position + filled,
                );
                if (bytesRead === 0) throw changed();
                filled += bytesRead;
              }
            },
          });
          if (
            !sameRegularFileState(initial, await file.stat({ bigint: true })) ||
            !sameRegularFileState(
              initial,
              await this.files.stat(path, { bigint: true }),
            )
          )
            throw changed();
          assertArtifactReadActive(options?.signal);
          return result;
        },
      );
      return completeProviderEvidence(
        evidenceFromReport(report),
        options?.signal,
      );
    } catch (cause) {
      const completion = artifactFileCompletion(cause);
      if (cause instanceof ArtifactFileCleanupFailure) {
        const outcome = cause.fileCleanupFailure.outcome;
        const cleanup = new AnalysisOutputError(
          operation,
          "Could not confirm closing the selected file.",
          {
            cause,
            cleanup: cause.cleanup,
            ...(completion === undefined
              ? {}
              : { partialObservation: completedObservation(completion.value) }),
          },
        );
        bindArtifactFileCleanup(cause, cleanup);
        if (
          outcome.kind === "failed" &&
          outcome.cause instanceof ArtifactReaderFailure &&
          outcome.cause.reason === "cancelled"
        ) {
          const cancelled = new AnalysisCancelledError(operation, {
            cause: artifactFileCancellationCause(outcome.cause),
            cleanup: cause.cleanup,
          }).retainSecondaryFailure(cleanup);
          bindArtifactFileCleanup(cause, cancelled);
          return err(cancelled);
        }
        const cancellation = completion?.cancellation;
        if (cancellation !== undefined) {
          const cancelled = new AnalysisCancelledError(operation, {
            cause: cancellation.reason,
            partialObservation: cleanup.partialObservation,
            cleanup: cause.cleanup,
          }).retainSecondaryFailure(cleanup);
          bindArtifactFileCleanup(cause, cancelled);
          return err(cancelled);
        }
        if (outcome.kind === "failed") {
          const primary = readFailure(outcome.cause);
          return err(
            analysisErrorWithCleanupFailure(
              primary,
              cleanup,
              operation,
            ).bindCleanupDependencies([primary, cleanup]),
          );
        }
        return err(cleanup);
      }
      if (cause instanceof ArtifactReaderFailure) {
        if (cause.reason === "cancelled") {
          const cancelled = new AnalysisCancelledError(operation, {
            cause: artifactFileCancellationCause(cause),
            ...(completion === undefined
              ? {}
              : { partialObservation: completedObservation(completion.value) }),
          });
          bindArtifactFileCleanup(cause, cancelled);
          return err(cancelled);
        }
        const retry = new AnalysisOutputError(
          operation,
          "A previous raw-bytes file descriptor is still owned; cleanup must succeed before another file can be inspected.",
          {
            cause,
            ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
          },
        );
        bindArtifactFileCleanup(cause, retry);
        return err(retry);
      }
      return err(readFailure(cause));
    }
  }
}
