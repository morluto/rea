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
  runSourceMapCommand,
  type SourceMapDecoderDependencies,
} from "./SourceMapCommand.js";
export type { SourceMapDecoderDependencies } from "./SourceMapCommand.js";
const OPERATION = "trace_web_source_location";

/** Integrate the pinned upstream codec through an independently bounded owned process. */
export class SourceMapDecoder implements WebSourceMapPort {
  constructor(readonly dependencies: SourceMapDecoderDependencies = {}) {}
  /** Return complete point evidence after process and private-root cleanup. */
  async trace(
    input: Parameters<WebSourceMapPort["trace"]>[0],
    options?: ExecutionOptions,
  ): Promise<Result<WebSourceMapReport, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const request = sourceMapCodecInputSchema.safeParse({
      text: input.text,
      url: input.url,
      position: input.position,
    });
    if (!request.success)
      return err(new AnalysisInputError(OPERATION, { cause: request.error }));
    const serialized = JSON.stringify(request.data);
    if (
      Buffer.byteLength(input.text) > WEB_SOURCE_MAP_LIMITS.mapBytes ||
      Buffer.byteLength(serialized) > WEB_SOURCE_MAP_LIMITS.outputBytes
    )
      return err(
        new ArtifactOperationError(
          OPERATION,
          "limit",
          undefined,
          `${input.path}: Source-map input exceeds the 4 MiB map or 32 MiB encoded request budget.`,
        ),
      );
    const response = await runSourceMapCommand(
      serialized,
      input.path,
      options,
      this.dependencies,
    );
    if (!response.ok) return response;
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
