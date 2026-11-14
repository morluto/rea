import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import {
  selectedSourceMapLimits,
  sourceMapLimitRecovery,
  sourceMapLimitsSchema,
} from "../../domain/sourceMapLimits.js";
import { traceSourceMap } from "./TraceSourceMap.js";
import { SourceMapFormatFailure } from "./SourceMapFormat.js";
import {
  sourceMapCodecInputSchema,
  sourceMapCodecReplySchema,
} from "./SourceMapCodecProtocol.js";
import { z } from "zod";

/** Dedicated process entrypoint invoked only for an explicitly selected map. */
const execute = async (): Promise<string> => {
  try {
    const path = process.argv[2];
    if (path === undefined)
      throw new SourceMapFormatFailure(
        "format",
        "Codec request path is missing.",
      );
    const selected = sourceMapLimitsSchema.parse(
      JSON.parse(process.argv[3] ?? "{}"),
    );
    const limits = selectedSourceMapLimits(selected);
    const data = await readStableArtifact(path, limits.outputBytes);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data.bytes);
    const value: unknown = JSON.parse(text);
    const input = sourceMapCodecInputSchema.parse(value);
    if (Buffer.byteLength(input.text) > limits.mapBytes)
      throw new SourceMapFormatFailure(
        "limit",
        `Source map exceeds codec input admission. ${sourceMapLimitRecovery("map_bytes", limits.mapBytes)}`,
      );
    const report = traceSourceMap(
      input.text,
      input.url,
      input.position,
      limits,
    );
    const reply = JSON.stringify(
      sourceMapCodecReplySchema.parse({ state: "success", report }),
    );
    if (Buffer.byteLength(reply) > limits.outputBytes)
      throw new SourceMapFormatFailure(
        "limit",
        `Complete source-map point evidence exceeds output admission; no partial evidence was returned. ${sourceMapLimitRecovery("output_bytes", limits.outputBytes)}`,
      );
    return reply;
  } catch (cause: unknown) {
    if (
      !(
        cause instanceof SourceMapFormatFailure ||
        cause instanceof z.ZodError ||
        cause instanceof SyntaxError
      )
    )
      throw cause;
    return JSON.stringify({
      state: "failure",
      reason:
        cause instanceof SourceMapFormatFailure &&
        cause.reason !== "section-overlap"
          ? cause.reason
          : "format",
      message: cause.message,
    });
  }
};

process.stdout.write(await execute());
