import { QueuedProviderClose } from "../../providers/QueuedProviderClose.js";
import {
  selectedSourceMapLimits,
  localSourceMapLimitsSchema,
  sourceMapBudgetLimit,
  sourceMapLimitRecovery,
} from "../../domain/sourceMapLimits.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { WebSourceMapPort } from "../../ports/WebSourceLocationPorts.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisErrorWithCancellation } from "../../domain/analysisErrorCancellation.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  cancelledBy,
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
import { jsonParts } from "../../domain/jsonSerialization.js";
import {
  AbortedWait,
  waitForAbortable,
} from "../../process/AbortablePromise.js";
const OPERATION = "trace_web_source_location";

/** Integrate the pinned upstream codec through an independently bounded owned process. */
export class SourceMapDecoder implements WebSourceMapPort {
  #tail: Promise<void> = Promise.resolve();
  readonly #closeState = new QueuedProviderClose();
  #pendingCleanup: SourceMapCleanupOwner | undefined;

  constructor(readonly dependencies: SourceMapDecoderDependencies = {}) {}
  /** Return complete point evidence after process and private-root cleanup. */
  async trace(
    input: Parameters<WebSourceMapPort["trace"]>[0],
    options?: ExecutionOptions,
  ): Promise<Result<WebSourceMapReport, AnalysisError>> {
    if (this.#closeState.requested)
      return err(
        new AnalysisCapabilityUnavailableError(
          "source-map-decoder",
          OPERATION,
          "Provider is closing",
        ),
      );
    const predecessor = this.#tail;
    let releaseTurn!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const ready = await waitForAbortable(predecessor, options?.signal);
    if (ready instanceof AbortedWait) {
      // The caller can leave before admission, but later work still queues
      // behind the request that owns the decoder and its cleanup.
      void predecessor.then(releaseTurn);
      return err(cancelledBy(OPERATION, ready));
    }
    try {
      return this.#closeState.requested
        ? err(
            new AnalysisCapabilityUnavailableError(
              "source-map-decoder",
              OPERATION,
              "Provider is closing",
            ),
          )
        : await this.#trace(input, options);
    } finally {
      releaseTurn();
    }
  }

  async #trace(
    input: Parameters<WebSourceMapPort["trace"]>[0],
    options?: ExecutionOptions,
  ): Promise<Result<WebSourceMapReport, AnalysisError>> {
    const cleanupFailure = await this.#retryCleanup();
    if (cleanupFailure !== undefined)
      return err(
        options?.signal?.aborted
          ? analysisErrorWithCancellation(
              cleanupFailure,
              cancelledBy(OPERATION, options.signal),
            )
          : cleanupFailure,
      );
    if (options?.signal?.aborted)
      return err(cancelledBy(OPERATION, options.signal));
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
      requiredValue?: number,
    ) => {
      const recovery = sourceMapLimitRecovery(field, value);
      return new ArtifactOperationError(
        OPERATION,
        "limit",
        undefined,
        `${input.path}: Source-map admission exhausted. ${recovery}`,
        {
          limit: sourceMapBudgetLimit(field, value, requiredValue),
          remediationAction: recovery,
        },
      );
    };
    const inputBytes = Buffer.byteLength(input.text);
    if (inputBytes > limits.mapBytes)
      return err(capacityFailure("map_bytes", limits.mapBytes, inputBytes));
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
      return err(cancelledBy(OPERATION, options.signal));
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
    return this.#closeState.closeAfter(this.#tail, () => this.#retryCleanup());
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
