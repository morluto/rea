import type { z } from "zod";
import { setImmediate } from "node:timers/promises";
import { absoluteCallerPath } from "../../filesystem/callerPath.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { REA_WORKFLOW_PROVIDER } from "../../domain/investigationProviders.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "../../providers/classifyProviderFailure.js";
import {
  AnalysisOutputError,
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  cancelledBy,
  carriedReason,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import {
  createEvidence,
  withEvidenceCallerInputPath,
  type Evidence,
} from "../../domain/evidence.js";
import { err, type Result } from "../../domain/result.js";
import {
  ArtifactResourceScope,
  ArtifactReaderFailure,
  withArtifactFileHandle,
  bindArtifactFileCleanup,
  ArtifactFileCleanupFailure,
  artifactFileCompletion,
  assertArtifactReadActive,
  artifactFileCancellationCause,
  artifactSelectedPathErrno,
} from "../../resources/index.js";
import { analysisErrorWithCleanupDependencies } from "../../domain/analysisErrorCleanup.js";
import { sameRegularFileState } from "../../filesystem/RegularFile.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

/** Bound retained result rows before constructing the Evidence representation. */
const MAX_FILE_BYTES = 128 * 1024 * 1024;

interface RasterAnalysisInput {
  path: string;
  offset: number;
  length?: number | undefined;
}
interface RasterAnalysisReport {
  artifact: { path: string; bytes: number; sha256: string };
  limitations: string[];
}
export interface SelectedRasterAnalysisDefinition<
  Input extends RasterAnalysisInput,
  Report extends RasterAnalysisReport,
> {
  operation: string;
  inputSchema: z.ZodType<Input>;
  reportSchema: z.ZodType<Report>;
  analyze(
    bytes: Uint8Array,
    input: Input,
    fileSize: number,
    signal?: AbortSignal,
  ): { limitations: string[]; [key: string]: unknown };
}

/** Offline byte observations shared by CLI and MCP, with one file-wide read. */
export class SelectedRasterAnalysisService<
  Input extends RasterAnalysisInput,
  Report extends RasterAnalysisReport,
> {
  readonly #resources: ArtifactResourceScope;

  constructor(
    private readonly definition: SelectedRasterAnalysisDefinition<
      Input,
      Report
    >,
    private readonly files: Pick<
      typeof import("node:fs/promises"),
      "open" | "stat"
    > = { open, stat },
    resources: ArtifactResourceScope = new ArtifactResourceScope(),
  ) {
    this.#resources = resources;
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    try {
      return await this.#resources.run(() => this.#inspect(rawInput, options));
    } catch (cause: unknown) {
      const failure = new AnalysisOutputError(
        this.definition.operation,
        "A retained raster-analysis file descriptor could not be released before inspection.",
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

  close(): Promise<void> {
    return this.#resources.close();
  }

  async #inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const invalid = (field: string, message: string) =>
      new AnalysisInputError(this.definition.operation, undefined, [
        { path: [field], reason: "invalid_value", message },
      ]);
    const parsed = parseAnalysisInput(
      this.definition.operation,
      rawInput,
      this.definition.inputSchema,
      options?.signal,
    );
    if (!parsed.ok) return parsed;
    let input = parsed.value;
    const callerInputPath = input.path;
    input = { ...input, path: absoluteCallerPath(input.path) };
    const evidenceFromReport = (report: Report): Evidence =>
      withEvidenceCallerInputPath(
        createEvidence(
          { path: input.path, format: "file", sha256: report.artifact.sha256 },
          REA_WORKFLOW_PROVIDER,
          {
            operation: this.definition.operation,
            parameters: Object.fromEntries(
              Object.entries(input).filter(([, value]) => value !== undefined),
            ),
            result: report,
            rawResult: null,
            confidence: "inferred",
            limitations: report.limitations,
            locations: [{ kind: "artifact-path", path: input.path }],
          },
        ),
        callerInputPath,
      );
    // Cleanup errors erase the callback's generic type. Validate their completed
    // value before publishing it as this operation's observation.
    const completedObservation = (value: unknown): Evidence | undefined => {
      const report = this.definition.reportSchema.safeParse(value);
      return report.success && report.data.artifact.path === input.path
        ? evidenceFromReport(report.data)
        : undefined;
    };
    let admitted = false;
    const failureDialect: ProviderFailureDialect = {
      providerId: REA_WORKFLOW_PROVIDER.id,
      operation: this.definition.operation,
      // Admission owns the distinction between an unavailable selected path
      // and a path that disappeared after its identity was admitted.
      recognise: (cause, details) => {
        if (!(cause instanceof Error) || !("code" in cause)) return undefined;
        if (cause.code === "EACCES" || cause.code === "EPERM")
          return new AnalysisAccessDeniedError(
            this.definition.operation,
            input.path,
            cause.code,
            { ...details, cause },
          );
        const pathErrno = artifactSelectedPathErrno(cause);
        if (pathErrno === undefined) return undefined;
        return admitted
          ? new AnalysisArtifactChangedError(
              this.definition.operation,
              input.path,
              "Selected file path changed during raster candidate inspection.",
              { ...details, cause },
            )
          : new AnalysisInputError(
              this.definition.operation,
              { ...details, cause },
              [
                {
                  path: ["path"],
                  reason: "invalid_value",
                  message:
                    pathErrno === "ENOENT" || pathErrno === "ENOTDIR"
                      ? "Selected file could not be found."
                      : pathErrno === "ELOOP"
                        ? `Selected file path could not be resolved because symbolic-link traversal looped or exceeded the host limit (ELOOP): ${input.path}`
                        : `Selected file path exceeds the host path or component length limit (ENAMETOOLONG): ${input.path}`,
                },
              ],
            );
      },
      unclassified: (cause, details) =>
        new AnalysisOutputError(
          this.definition.operation,
          cause instanceof ArtifactReaderFailure
            ? cause.message
            : "Could not read complete raster analysis evidence.",
          { ...details, cause },
        ),
    };
    try {
      const before = await this.files.stat(input.path, { bigint: true });
      if (!before.isFile()) throw invalid("path", "Expected a regular file.");
      admitted = true;
      // Only an admitted selected file may consult filesystem spelling. Do not
      // replace symlink/junction/8.3 aliases or touch source-derived paths.
      if (process.platform === "win32") {
        const canonical = await realpath(input.path).catch(() => undefined);
        assertArtifactReadActive(options?.signal);
        if (canonical?.toLowerCase() === input.path.toLowerCase())
          input = { ...input, path: canonical };
      }
      const file = await this.files.open(
        input.path,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      const report = await withArtifactFileHandle(
        input.path,
        file,
        this.#resources,
        options?.signal,
        async (file) => {
          const initial = await file.stat({ bigint: true });
          const changed = () =>
            new AnalysisArtifactChangedError(
              this.definition.operation,
              input.path,
              "File identity, size or timestamps changed during raster candidate inspection.",
            );
          if (!initial.isFile() || !sameRegularFileState(initial, before))
            throw changed();
          const size = Number(initial.size);
          if (!Number.isSafeInteger(size))
            throw invalid(
              "path",
              "File size exceeds exact numeric offset representation.",
            );
          if (input.offset > size)
            throw invalid(
              "offset",
              "Selected byte window starts beyond the end of the file.",
            );
          const length = input.length ?? size - input.offset;
          if (length > size - input.offset)
            throw invalid(
              "length",
              "Selected byte window extends beyond the end of the file.",
            );
          if (size > MAX_FILE_BYTES || length > 16 * 1024 * 1024)
            throw new AnalysisResourceConstraintError(
              this.definition.operation,
              "capacity",
              "Discovery accepts at most a 128 MiB file and a 16 MiB selected range.",
              {
                max_file_bytes: MAX_FILE_BYTES,
                max_selected_bytes: 16 * 1024 * 1024,
              },
              {
                retryable: false,
                remediationAction:
                  "Use a smaller local artifact or selected range.",
              },
            );
          if (length === 0)
            throw invalid("length", "Select at least one byte.");
          const selectedBytes = Buffer.alloc(length);
          const end = input.offset + length;
          const buffer = Buffer.alloc(65_536);
          const hash = createHash("sha256");
          let position = 0;
          while (position < size) {
            assertArtifactReadActive(options?.signal);
            const selected = position >= input.offset && position < end;
            const boundary =
              position < input.offset ? input.offset : selected ? end : size;
            const wanted = Math.min(buffer.length, boundary - position);
            let filled = 0;
            while (filled < wanted) {
              assertArtifactReadActive(options?.signal);
              const { bytesRead } = await file.read(
                buffer,
                filled,
                wanted - filled,
                position + filled,
              );
              if (bytesRead === 0) throw changed();
              filled += bytesRead;
            }
            const bytes = buffer.subarray(0, filled);
            hash.update(bytes);
            if (selected) selectedBytes.set(bytes, position - input.offset);
            position += filled;
          }
          if (
            !sameRegularFileState(initial, await file.stat({ bigint: true })) ||
            !sameRegularFileState(
              initial,
              await this.files.stat(input.path, { bigint: true }),
            )
          )
            throw changed();
          assertArtifactReadActive(options?.signal);
          // Yield before bounded synchronous scoring so queued cancellation is observed.
          await setImmediate();
          assertArtifactReadActive(options?.signal);
          let discovery;
          try {
            discovery = this.definition.analyze(
              selectedBytes,
              input,
              size,
              options?.signal,
            );
          } catch (cause) {
            if (cause instanceof RangeError)
              throw invalid("path", cause.message);
            throw cause;
          }
          await setImmediate();
          assertArtifactReadActive(options?.signal);
          return this.definition.reportSchema.parse({
            ...discovery,
            artifact: {
              path: input.path,
              bytes: size,
              sha256: hash.digest("hex"),
            },
            window: { offset: input.offset, length },
            limitations: [
              ...discovery.limitations,
              "Artifact SHA-256 covers the entire file. Metadata matched before and after reading, not an immutable snapshot guarantee.",
              "Synchronous scoring checks cancellation between hypotheses; cancellation delivered by the event loop is observed before and after this bounded scoring phase.",
            ],
          });
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
          this.definition.operation,
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
          const cancelled = cancelledBy(
            this.definition.operation,
            carriedReason(artifactFileCancellationCause(outcome.cause)),
            { cleanup: cause.cleanup },
          ).retainSecondaryFailure(cleanup);
          bindArtifactFileCleanup(cause, cancelled);
          return err(cancelled);
        }
        const cancellation = completion?.cancellation;
        if (cancellation !== undefined) {
          const cancelled = cancelledBy(
            this.definition.operation,
            carriedReason(cancellation.reason),
            {
              partialObservation: cleanup.partialObservation,
              cleanup: cause.cleanup,
            },
          ).retainSecondaryFailure(cleanup);
          bindArtifactFileCleanup(cause, cancelled);
          return err(cancelled);
        }
        if (outcome.kind === "failed") {
          const primary = classifyProviderFailure(
            outcome.cause,
            failureDialect,
          );
          return err(
            analysisErrorWithCleanupDependencies(
              primary,
              cleanup,
              this.definition.operation,
            ),
          );
        }
        return err(cleanup);
      }
      if (cause instanceof ArtifactReaderFailure) {
        if (cause.reason === "cancelled") {
          const cancelled = cancelledBy(
            this.definition.operation,
            carriedReason(artifactFileCancellationCause(cause)),
            completion === undefined
              ? {}
              : { partialObservation: completedObservation(completion.value) },
          );
          bindArtifactFileCleanup(cause, cancelled);
          return err(cancelled);
        }
        const retry = new AnalysisOutputError(
          this.definition.operation,
          "A previous raster-analysis file descriptor is still owned; cleanup must succeed before another file can be inspected.",
          {
            cause,
            ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
          },
        );
        bindArtifactFileCleanup(cause, retry);
        return err(retry);
      }
      return err(classifyProviderFailure(cause, failureDialect));
    }
  }
}
