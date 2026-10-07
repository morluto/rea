import { historicalCaptureFailure } from "./CaptureFailures.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import type { HistoricalCaptureFormatAdapter } from "./HistoricalCaptureFormatAdapter.js";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  WEB_NETWORK_CAPTURE_LIMITS,
  webNetworkCaptureSchema,
  type InspectWebNetworkCaptureInput,
  type WebNetworkCapture,
} from "../../domain/webNetworkCapture.js";
import { runOwnedCommand } from "../../process/OwnedCommand.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import { redactExplicitFailure } from "../../domain/explicitSensitiveFailure.js";

const OPERATION = "inspect_web_network_capture";
const decodedSchema = webNetworkCaptureSchema.omit({
  artifact: true,
  format: true,
  runtime_attribution: true,
  limitations: true,
});
const replySchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: decodedSchema }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum([
      "format",
      "unsupported",
      "input-limit",
      "resource-limit",
      "decoder",
      "limit",
    ]),
    message: z.string(),
    pointer: z.string(),
  }),
]);

/** One owned snapshot/process/root lifecycle for replaceable historical format decoders. */
export class HistoricalCaptureDecoder {
  constructor(
    readonly adapters: readonly HistoricalCaptureFormatAdapter[],
    readonly environment: Readonly<NodeJS.ProcessEnv>,
    readonly createRuntime: () => Promise<
      Pick<PrivateRuntimeRoot, "path" | "close">
    > = () => PrivateRuntimeRoot.create({ prefix: "rea-web-capture-" }),
  ) {}

  /** Snapshot the selected artifact, decode it offline, and release private credentials and processes. */
  async inspect(
    input: InspectWebNetworkCaptureInput,
    options?: ExecutionOptions,
  ): Promise<Result<WebNetworkCapture, AnalysisError>> {
    let runtime: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
    let result: Result<WebNetworkCapture, AnalysisError>;
    let phase: "capture-read" | "decoder" = "capture-read";
    try {
      const adapter = this.adapters.find(
        (candidate) => candidate.format === input.format,
      );
      if (adapter === undefined)
        throw new AnalysisCapabilityUnavailableError(
          input.format,
          OPERATION,
          "No adapter is configured for the selected capture format.",
        );
      const snapshot = await readStableArtifact(
        input.capture_path,
        WEB_NETWORK_CAPTURE_LIMITS.inputBytes,
        options?.signal,
      );
      phase = "decoder";
      runtime = await this.createRuntime();
      const snapshotPath = join(runtime.path, "capture.snapshot");
      const requestPath = join(runtime.path, "request.json");
      const replyPath = join(runtime.path, "reply.json");
      await writeFile(snapshotPath, snapshot.bytes, {
        mode: 0o600,
        flag: "wx",
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      await writeFile(
        requestPath,
        JSON.stringify({
          snapshot_path: snapshotPath,
          reply_path: replyPath,
          sensitive_values: input.sensitive_values,
        }),
        { mode: 0o600, flag: "wx" },
      );
      const command = await adapter.command(requestPath, runtime.path);
      const environment: NodeJS.ProcessEnv = {
        ...this.environment,
        UV_THREADPOOL_SIZE: "1",
      };
      delete environment.NODE_OPTIONS;
      await runOwnedCommand(
        {
          ...command,
          runId: `rea-web-capture-${randomUUID()}`,
          cwd: runtime.path,
          hostEnvironment: environment,
        },
        {
          timeoutMs: WEB_NETWORK_CAPTURE_LIMITS.timeoutMs,
          diagnosticBytes: 1024 * 1024,
        },
        options?.signal === undefined ? {} : { signal: options.signal },
      );
      let reply: z.output<typeof replySchema>;
      try {
        const replyFile = await readStableArtifact(
          replyPath,
          WEB_NETWORK_CAPTURE_LIMITS.outputBytes,
          options?.signal,
        );
        reply = replySchema.parse(JSON.parse(replyFile.bytes.toString("utf8")));
      } catch (cause: unknown) {
        if (options?.signal?.aborted)
          throw new AnalysisCancelledError(OPERATION);
        throw new AnalysisOutputError(
          OPERATION,
          `Owned capture decoder reply failed for ${input.capture_path}: ${replyFailureReason(cause)}`,
          { cause },
        );
      }
      if (!reply.ok) {
        if (reply.reason === "format")
          throw new AnalysisInputError(OPERATION, undefined, [
            {
              path: ["capture_path", reply.pointer],
              reason: "invalid_format",
              message: reply.message,
            },
          ]);
        if (reply.reason === "input-limit")
          throw new AnalysisInputError(OPERATION, undefined, [
            {
              path: ["capture_path", reply.pointer],
              reason: "out_of_range",
              message: reply.message,
              expected: {
                maximum_capture_nesting: WEB_NETWORK_CAPTURE_LIMITS.depth,
              },
            },
          ]);
        if (reply.reason === "decoder" || reply.reason === "resource-limit")
          throw new ProviderAdapterError(input.format, OPERATION, {
            diagnostics: {
              phase: "decoder",
              failure_kind: reply.reason,
              reason: reply.message,
              pointer: reply.pointer,
            },
          });
        if (reply.reason === "unsupported")
          throw new AnalysisCapabilityUnavailableError(
            input.format,
            OPERATION,
            reply.message,
          );
        throw new AnalysisOutputError(OPERATION, reply.message);
      }
      if (
        reply.value.decoder.id !== adapter.identity.id ||
        reply.value.decoder.name !== adapter.identity.name ||
        reply.value.decoder.version !== adapter.identity.version
      )
        throw new AnalysisOutputError(
          OPERATION,
          "Capture decoder changed the selected upstream profile identity.",
        );
      result = ok({
        ...reply.value,
        artifact: {
          path: input.capture_path,
          sha256: snapshot.sha256,
          bytes: snapshot.bytes.length,
        },
        format: input.format,
        runtime_attribution: "unknown",
        limitations: [
          "This is retained producer evidence, without live browser transaction IDs, scenario provenance, execution attribution or deployment authenticity. Recorded URLs are never fetched.",
          "Every record is decoded before selection; no partial success is returned on malformed input or a resource limit.",
          "Known authentication headers/cookies and explicitly marked literal values are excluded. Unknown extension names do not establish sensitivity.",
          "A 32 MiB input, 96 MiB reply and 64-level nesting budget bound complete evidence. HAR uses a 192 MiB Node old-generation heap; native decoding uses a 768 MiB Linux address-space limit. Each owned command has a 30-second deadline with independent cleanup.",
        ],
      });
    } catch (cause: unknown) {
      result = err(
        redactExplicitFailure(
          historicalCaptureFailure(input, cause, phase, options),
          input.sensitive_values,
        ),
      );
    }
    if (runtime !== undefined) {
      try {
        await runtime.close();
      } catch (cause: unknown) {
        return err(
          redactExplicitFailure(
            new ProviderCleanupError(
              input.format,
              [runtime.path],
              {
                capture_path: input.capture_path,
                previous_error: result.ok
                  ? null
                  : projectAnalysisError(result.error),
                reason: cause instanceof Error ? cause.message : String(cause),
              },
              { operation: OPERATION },
            ),
            input.sensitive_values,
          ),
        );
      }
    }
    return result.ok && options?.signal?.aborted
      ? err(new AnalysisCancelledError(OPERATION))
      : result;
  }
}

const replyFailureReason = (cause: unknown): string => {
  if (cause instanceof ArtifactReaderFailure) return cause.message;
  if (cause instanceof z.ZodError)
    return `Reply violates its schema at ${cause.issues[0]?.path.map(String).join(".") ?? "root"}.`;
  if (cause instanceof SyntaxError) return "Reply is malformed JSON.";
  if (cause instanceof Error && "code" in cause)
    return `Reply file could not be read (${String(cause.code)}).`;
  return "Reply could not be validated.";
};
