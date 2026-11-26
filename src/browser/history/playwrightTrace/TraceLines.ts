import { setImmediate } from "node:timers/promises";
import type { Readable } from "node:stream";
import { assertArtifactReadActive } from "../../../resources/index.js";
import { AnalysisResourceConstraintError } from "../../../domain/analysisErrorCore.js";
import {
  PLAYWRIGHT_TRACE_OPERATION,
  playwrightTraceLimitRecovery,
  type PlaywrightTraceLimits,
} from "../../../domain/playwrightTrace/playwrightTrace.js";

export interface TraceLineBudget {
  decodedBytes: number;
  readonly limits: PlaywrightTraceLimits;
}
/** Buffer one physical line; do not decode a partial UTF-8 sequence or split records by characters. */
export async function* traceLines(
  stream: Readable,
  budget: TraceLineBudget,
  signal?: AbortSignal,
): AsyncGenerator<{ line: number; bytes: Buffer }> {
  let fragments: Buffer[] = [];
  let pendingBytes = 0;
  let line = 0;
  const append = (part: Buffer) => {
    pendingBytes += part.length;
    if (pendingBytes > budget.limits.line_bytes)
      throw new AnalysisResourceConstraintError(
        PLAYWRIGHT_TRACE_OPERATION,
        "memory",
        `A trace line exceeds the ${String(budget.limits.line_bytes)}-byte parser representation allowance.`,
        { max_line_bytes: budget.limits.line_bytes },
        playwrightTraceLimitRecovery("line_bytes", budget.limits),
      );
    fragments.push(part);
  };
  for await (const chunk of stream) {
    assertArtifactReadActive(signal);
    if (!Buffer.isBuffer(chunk))
      throw new TypeError("ZIP trace stream returned non-byte data");
    budget.decodedBytes += chunk.length;
    if (budget.decodedBytes > budget.limits.decoded_bytes)
      throw new AnalysisResourceConstraintError(
        PLAYWRIGHT_TRACE_OPERATION,
        "memory",
        `Decoded trace streams exceed the ${String(budget.limits.decoded_bytes)}-byte analysis allowance.`,
        { max_decoded_bytes: budget.limits.decoded_bytes },
        playwrightTraceLimitRecovery("decoded_bytes", budget.limits),
      );
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(10, start);
      if (end === -1) {
        if (start < chunk.length) append(chunk.subarray(start));
        break;
      }
      append(chunk.subarray(start, end));
      const bytes =
        fragments.length === 1
          ? fragments[0]!
          : Buffer.concat(fragments, pendingBytes);
      line++;
      yield { line, bytes };
      fragments = [];
      pendingBytes = 0;
      start = end + 1;
      if (line % 128 === 0) {
        await setImmediate();
        assertArtifactReadActive(signal);
      }
    }
  }
  if (pendingBytes > 0)
    yield { line: line + 1, bytes: Buffer.concat(fragments, pendingBytes) };
}
