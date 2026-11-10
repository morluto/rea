import {
  selectedSourceMapLimits,
  localSourceMapLimitsSchema,
  sourceMapLimitRecovery,
} from "../../domain/sourceMapLimits.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import type { WebSourceMapPort } from "../../application/WebSourceLocationPorts.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { err, type Result } from "../../domain/result.js";
import {
  DEFAULT_WEB_SOURCE_MAP_DECODE_TIMEOUT_MS,
  type WebSourceMapReport,
} from "../../domain/webSourceLocation.js";
import { sourceMapCodecInputSchema } from "./SourceMapCodecProtocol.js";
import {
  runSourceMapCommand,
  type SourceMapCleanupOwner,
  type SourceMapCleanupRetention,
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
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    const request = sourceMapCodecInputSchema.safeParse({
      text: input.text,
      url: input.url,
      position: input.position,
    });
    if (!request.success)
      return err(new AnalysisInputError(OPERATION, { cause: request.error }));
    const selected = localSourceMapLimitsSchema.safeParse(input.limits ?? {});
    if (!selected.success)
      return err(new AnalysisInputError(OPERATION, { cause: selected.error }));
    const limits = selectedSourceMapLimits(selected.data);
    const capacityFailure = (
      field: "map_bytes" | "output_bytes",
      value: number,
    ) => {
      const recovery = sourceMapLimitRecovery(field, value);
      return new ArtifactOperationError(
        OPERATION,
        "limit",
        undefined,
        `${input.path}: Source-map admission exhausted. ${recovery}`,
        { remediationAction: recovery },
      );
    };
    if (Buffer.byteLength(input.text) > limits.mapBytes)
      return err(capacityFailure("map_bytes", limits.mapBytes));
    const encoded: string[] = [];
    let encodedBytes = 0;
    for (const part of jsonParts(request.data)) {
      const bytes = Buffer.byteLength(part);
      if (bytes > limits.outputBytes - encodedBytes)
        return err(capacityFailure("output_bytes", limits.outputBytes));
      encoded.push(part);
      encodedBytes += bytes;
    }
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    const serialized = encoded.join("");
    const retainedCleanup: SourceMapCleanupRetention = {};
    const response = await runSourceMapCommand(
      serialized,
      input.path,
      options,
      this.dependencies,
      retainedCleanup,
      input.decodeTimeoutMs ?? DEFAULT_WEB_SOURCE_MAP_DECODE_TIMEOUT_MS,
      limits,
    );
    if (retainedCleanup.owner !== undefined)
      this.#pendingCleanup = retainedCleanup.owner;
    return response;
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
    const failure = await pending.close();
    if (failure !== undefined) return failure;
    this.#pendingCleanup = undefined;
    return undefined;
  }
}
