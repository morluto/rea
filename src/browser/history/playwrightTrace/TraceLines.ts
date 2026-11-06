import { setImmediate } from "node:timers/promises";
import type { Readable } from "node:stream";
import { assertArtifactReadActive } from "../../../artifacts/ArtifactFileOperation.js";
import { AnalysisResourceConstraintError } from "../../../domain/analysisErrorCore.js";
import {
  PLAYWRIGHT_TRACE_LIMITS,
  PLAYWRIGHT_TRACE_OPERATION,
} from "../../../domain/playwrightTrace/playwrightTrace.js";

export interface TraceLineBudget {
  decodedBytes: number;
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
    if (pendingBytes > PLAYWRIGHT_TRACE_LIMITS.lineBytes)
      throw new AnalysisResourceConstraintError(
        PLAYWRIGHT_TRACE_OPERATION,
        "memory",
        "A trace line exceeds the 4 MiB parser representation allowance.",
        { max_line_bytes: PLAYWRIGHT_TRACE_LIMITS.lineBytes },
        {
          remediationAction:
            "Select a smaller recorder chunk; changing reply pagination does not change parsing allowances.",
        },
      );
    fragments.push(part);
  };
  for await (const chunk of stream) {
    assertArtifactReadActive(signal);
    if (!Buffer.isBuffer(chunk))
      throw new TypeError("ZIP trace stream returned non-byte data");
    budget.decodedBytes += chunk.length;
    if (budget.decodedBytes > PLAYWRIGHT_TRACE_LIMITS.decodedBytes)
      throw new AnalysisResourceConstraintError(
        PLAYWRIGHT_TRACE_OPERATION,
        "memory",
        "Decoded trace streams exceed the 32 MiB analysis allowance.",
        { max_decoded_bytes: PLAYWRIGHT_TRACE_LIMITS.decodedBytes },
        {
          remediationAction:
            "Select a smaller complete recorder chunk; binary resource payloads are not decoded by this tool.",
        },
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
