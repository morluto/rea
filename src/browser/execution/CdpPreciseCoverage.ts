import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import type { WebExecution } from "../../domain/webExecution.js";
import type { WebRuntimeSource } from "../../domain/webRuntime.js";
import { preciseCoverageSchema } from "./CdpRuntimeProtocol.js";
import type { CdpRuntimeSources } from "./CdpRuntimeSources.js";

/** Validate source-range bounds against exact retained UTF-16 text without flattening nested counts. */
export const normalizePreciseCoverage = (
  raw: unknown,
  sources: CdpRuntimeSources,
  retained: readonly WebRuntimeSource[],
): {
  readonly coverage: WebExecution["coverage"];
  readonly timestamp: number;
} => {
  const parsed = preciseCoverageSchema.safeParse(raw);
  if (!parsed.success)
    throw new AnalysisOutputError(
      sources.session.operation,
      `Malformed precise coverage: ${parsed.error.message}`,
    );
  const scripts: WebExecution["coverage"]["scripts"] = [];
  let excluded = 0;
  for (const script of parsed.data.result) {
    if (!sources.belongsToDocument(script.scriptId)) {
      excluded += 1;
      continue;
    }
    const source = retained.find(
      (item) => item.script_id === script.scriptId,
    )?.source;
    scripts.push({
      script_id: script.scriptId,
      reported_url: sources.sourceUrl(script.scriptId, script.url),
      functions: script.functions.map((fn) => ({
        name: fn.functionName,
        is_block_coverage: fn.isBlockCoverage,
        ranges: fn.ranges.map((range) => {
          if (
            range.endOffset < range.startOffset ||
            (source?.state === "captured" &&
              range.endOffset > source.utf16_units)
          )
            throw new AnalysisOutputError(
              sources.session.operation,
              `Script ${script.scriptId} coverage range ${range.startOffset}:${range.endOffset} is outside retained source bounds.`,
            );
          return {
            start_offset: range.startOffset,
            end_offset: range.endOffset,
            count: range.count,
            source_bounds:
              source?.state === "captured" ? "verified" : "unknown",
          };
        }),
      })),
    });
  }
  return {
    timestamp: parsed.data.timestamp,
    coverage: {
      state: "captured",
      reason: null,
      offset_units: "utf16-code-units",
      end_offset: "exclusive",
      scripts,
      excluded_scripts: excluded,
    },
  };
};
