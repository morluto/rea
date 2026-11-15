import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import {
  selectedSourceMapLimits,
  sourceMapLimitRecovery,
  sourceMapLimitsSchema,
} from "../../domain/sourceMapLimits.js";
import { traceSourceMap } from "./TraceSourceMap.js";
import {
  isSourceMapFailure,
  SOURCE_MAP_FORMAT,
  sourceMapLimitFailure,
} from "./SourceMapFormat.js";
import { malformedInput } from "../../domain/parseFailure.js";
import {
  sourceMapCodecInputSchema,
  sourceMapCodecReplySchema,
} from "./SourceMapCodecProtocol.js";
import { z } from "zod";
import { decodeStrictUtf8 } from "../../domain/strictUtf8.js";

/** Dedicated process entrypoint invoked only for an explicitly selected map. */
const execute = async (): Promise<string> => {
  try {
    const path = process.argv[2];
    if (path === undefined)
      throw malformedInput(SOURCE_MAP_FORMAT, "Codec request path is missing.");
    const selected = sourceMapLimitsSchema.parse(
      JSON.parse(process.argv[3] ?? "{}"),
    );
    const limits = selectedSourceMapLimits(selected);
    const data = await readStableArtifact(path, limits.outputBytes);
    // Source maps on disk may carry a BOM signature (RFC 8259 8.1).
    const text = decodeStrictUtf8(data.bytes, "strip-signature");
    const value: unknown = JSON.parse(text);
    const input = sourceMapCodecInputSchema.parse(value);
    if (Buffer.byteLength(input.text) > limits.mapBytes)
      throw sourceMapLimitFailure(
        `Source map exceeds codec input admission.`,
        "map_bytes",
        limits.mapBytes,
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
      throw sourceMapLimitFailure(
        `Complete source-map point evidence exceeds output admission; no partial evidence was returned.`,
        "output_bytes",
        limits.outputBytes,
      );
    return reply;
  } catch (cause: unknown) {
    if (
      !(
        isSourceMapFailure(cause) ||
        cause instanceof z.ZodError ||
        cause instanceof SyntaxError
      )
    )
      throw cause;
    return JSON.stringify({
      state: "failure",
      reason:
        !isSourceMapFailure(cause) ||
        cause.kind === "malformed" ||
        cause.kind === "truncated"
          ? "format"
          : cause.kind,
      message: cause.message,
    });
  }
};

process.stdout.write(await execute());
