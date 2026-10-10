import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import type { WebSourceMapPort } from "../../application/WebSourceLocationPorts.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  WEB_SOURCE_MAP_LIMITS,
  type WebSourceMapReport,
} from "../../domain/webSourceLocation.js";
import {
  sourceMapCodecInputSchema,
  sourceMapCodecReplySchema,
} from "./SourceMapCodecProtocol.js";
import {
  SourceMapCleanupFailure,
  runSourceMapCommand,
  type SourceMapCleanupOwner,
  type SourceMapDecoderDependencies,
} from "./SourceMapCommand.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { jsonParts } from "../../domain/jsonSerialization.js";
const OPERATION = "trace_web_source_location";

/** Integrate the pinned upstream codec through an independently bounded owned process. */
export class SourceMapDecoder implements WebSourceMapPort {
  #tail: Promise<void> = Promise.resolve();
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #pendingCleanup: SourceMapCleanupOwner | undefined;

  constructor(readonly dependencies: SourceMapDecoderDependencies = {}) {}
  /** Return complete point evidence after process and private-root cleanup. */
  trace(
    input: Parameters<WebSourceMapPort["trace"]>[0],
    options?: ExecutionOptions,
  ): Promise<Result<WebSourceMapReport, AnalysisError>> {
    if (this.#closing)
      return Promise.resolve(
        err(
          new ProviderCleanupError(
            "source-map-decoder",
            [],
            { reason: "Provider is closing" },
            { operation: OPERATION },
          ),
        ),
      );
    const operation = this.#tail.then(() =>
      this.#closing
        ? err(
            new ProviderCleanupError(
              "source-map-decoder",
              [],
              { reason: "Provider is closing" },
              { operation: OPERATION },
            ),
          )
        : this.#trace(input, options),
    );
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #trace(
    input: Parameters<WebSourceMapPort["trace"]>[0],
    options?: ExecutionOptions,
  ): Promise<Result<WebSourceMapReport, AnalysisError>> {
    const cleanupFailure = await this.#retryCleanup();
    if (cleanupFailure !== undefined) return err(cleanupFailure);
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const request = sourceMapCodecInputSchema.safeParse({
      text: input.text,
      url: input.url,
      position: input.position,
    });
    if (!request.success)
      return err(new AnalysisInputError(OPERATION, { cause: request.error }));
    const capacityFailure = () =>
      new ArtifactOperationError(
        OPERATION,
        "limit",
        undefined,
        `${input.path}: Source-map input exceeds the 4 MiB map or 32 MiB encoded request budget.`,
      );
    if (Buffer.byteLength(input.text) > WEB_SOURCE_MAP_LIMITS.mapBytes)
      return err(capacityFailure());
    const encoded: string[] = [];
    let encodedBytes = 0;
    for (const part of jsonParts(request.data)) {
      const bytes = Buffer.byteLength(part);
      if (bytes > WEB_SOURCE_MAP_LIMITS.outputBytes - encodedBytes)
        return err(capacityFailure());
      encoded.push(part);
      encodedBytes += bytes;
    }
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const serialized = encoded.join("");
    const response = await runSourceMapCommand(
      serialized,
      input.path,
      options,
      this.dependencies,
    );
    if (!response.ok) {
      if (response.error instanceof SourceMapCleanupFailure)
        this.#pendingCleanup = response.error.cleanupOwner;
      return response;
    }
    let value: unknown;
    try {
      value = JSON.parse(response.value);
    } catch (cause: unknown) {
      return err(
        new AnalysisOutputError(
          OPERATION,
          `Malformed codec JSON reply: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
    }
    const reply = sourceMapCodecReplySchema.safeParse(value);
    if (!reply.success)
      return err(
        new AnalysisOutputError(
          OPERATION,
          `Malformed codec reply: ${reply.error.message}`,
        ),
      );
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    if (reply.data.state === "failure")
      return codecFailure(input.path, reply.data.reason, reply.data.message);
    if (reply.data.report.runtime.v8_heap_limit_bytes > 256 * 1024 * 1024)
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Codec reported a V8 heap limit exceeding its independent process budget.",
        ),
      );
    return ok(reply.data.report);
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#tail
      .then(async () => {
        const failure = await this.#retryCleanup();
        if (failure !== undefined) throw failure;
      })
      .catch((cause: unknown) => {
        this.#closePromise = undefined;
        throw cause;
      });
    return this.#closePromise;
  }

  async #retryCleanup(): Promise<AnalysisError | undefined> {
    const pending = this.#pendingCleanup;
    if (pending === undefined) return undefined;
    const failure = await pending.close(null);
    if (failure !== undefined) return failure;
    this.#pendingCleanup = undefined;
    return undefined;
  }
}
const codecFailure = (
  path: string,
  reason: "format" | "unsupported" | "limit",
  detail: string,
): Result<never, AnalysisError> =>
  err(
    reason === "limit"
      ? new ArtifactOperationError(
          OPERATION,
          "limit",
          undefined,
          `${path}: ${detail}`,
        )
      : reason === "unsupported"
        ? new AnalysisCapabilityUnavailableError(
            "source-map-decoder",
            OPERATION,
            "unsupported_source_map_profile",
            { userMessage: `${path}: ${detail}` },
          )
        : new AnalysisInputError(OPERATION, undefined, [
            {
              path: ["source_map", "path"],
              reason: "invalid_format",
              message: `${path}: ${detail}`,
            },
          ]),
  );
