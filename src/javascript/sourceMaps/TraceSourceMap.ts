import { malformedInput } from "../../domain/parseFailure.js";
import {
  WEB_SOURCE_MAP_LIMITS,
  type SourceMapLimits,
} from "../../domain/sourceMapLimits.js";
import { createRequire } from "node:module";
import { getHeapStatistics } from "node:v8";
import type { TraceMap, SourceMapSegment } from "@jridgewell/trace-mapping";
import { z } from "zod";
import { javaScriptRuntime } from "../../domain/runtimeVersion.js";
import { javaScriptWorkerMemoryLimitBytes } from "../../process/JavaScriptWorkerMemoryLimit.js";
import { webSourceOffset } from "../../domain/webSourcePosition.js";
import { resolveJavaScriptSourceMapUrl } from "../../domain/javascript/javascriptSourceMapPaths.js";
import {
  webSourceMapReportSchema,
  type WebSourceMapReport,
} from "../../domain/webSourceLocation.js";
import type { WebSourcePosition } from "../../domain/webSourcePosition.js";
import {
  inspectSourceMap,
  SOURCE_MAP_FORMAT,
  sourceMapLimitFailure,
  type SourceMapSourceDeclaration,
} from "../../domain/sourceMapFormat.js";
import { decodeValidatedSourceMapLeaves } from "../../domain/decodedSourceMap.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";

const traceMappingVersion = z
  .object({ version: z.string().min(1) })
  .parse(
    createRequire(import.meta.url)("@jridgewell/trace-mapping/package.json"),
  ).version;

/** Decode with the pinned upstream codec; preserve every equal-position candidate. */
export const traceSourceMap = (
  text: string,
  url: string,
  position: WebSourcePosition,
  limits: SourceMapLimits = WEB_SOURCE_MAP_LIMITS,
): WebSourceMapReport => {
  const inspected = inspectSourceMap(text, { limits });
  const decodedLeaves = decodeValidatedSourceMapLeaves(inspected.leaves, url);
  const matched = greatestPosition(decodedLeaves, position);
  let bytes = 0;
  const matches: WebSourceMapReport["matches"] = [];
  const contentFactsCache = new Map<
    number,
    { readonly utf8_sha256: string; readonly utf8_bytes: number }
  >();
  let sourceBase = 0;
  for (const { leaf, map, rows } of decodedLeaves) {
    if (matched !== null) {
      const line = matched.line - leaf.offset.line - 1;
      const column = matched.column - (line === 0 ? leaf.offset.column : 0);
      const row = line >= 0 ? rows[line] : undefined;
      if (row !== undefined && row.length > 0) {
        const start = firstSegmentIndexAt(row, column);
        if (start !== -1) {
          for (let index = start; index < row.length; index += 1) {
            const segment = row[index]!;
            if (segment[0] !== column) break;
            const match = originalMatch(
              segment,
              map,
              url,
              inspected.declarations,
              sourceBase,
              contentFactsCache,
            );
            bytes += Buffer.byteLength(JSON.stringify(match)) + 1;
            if (bytes > limits.outputBytes)
              throw sourceMapLimitFailure(
                `Complete source-map point evidence exceeds output admission; no partial evidence was returned.`,
                "output_bytes",
                limits.outputBytes,
              );
            matches.push(match);
          }
        }
      }
    }
    sourceBase += leaf.map.sources.length;
  }
  const runtime = javaScriptRuntime(process.versions);
  return webSourceMapReportSchema.parse({
    source_map_sha256: sha256Hex(text),
    url_context: url,
    engine: { id: "jridgewell-trace-mapping", version: traceMappingVersion },
    // Bun reports V8-shaped heap statistics but ignores the codec's heap flags.
    // Its launcher applies the same runtime policy, and the parent verifies it.
    runtime:
      runtime.id === "node"
        ? {
            id: "node-v8",
            version: process.version,
            v8_heap_limit_bytes: getHeapStatistics().heap_size_limit,
          }
        : {
            id: "bun",
            version: runtime.version,
            node_compatibility_version: runtime.nodeCompatibilityVersion,
            v8_heap_limit_bytes: null,
            process_memory_limit_bytes: javaScriptWorkerMemoryLimitBytes(
              limits.codecHeapMiB,
            ),
          },
    format: inspected.format,
    reported_file: inspected.reportedFile,
    lookup: {
      requested: position,
      matched_generated_position: matched,
      semantics:
        "greatest generated position <= requested, across lines; all equal-position segments",
      location_units: "one-based lines; zero-based UTF-16 columns",
    },
    matches,
    diagnostics: [],
  });
};

/** Compare validated leaf positions without a second, clipping flatten operation. */
const greatestPosition = (
  leaves: ReturnType<typeof decodeValidatedSourceMapLeaves>,
  position: WebSourcePosition,
): WebSourcePosition | null => {
  let matched: WebSourcePosition | null = null;
  for (const { leaf, rows } of leaves) {
    const localLine = position.line - leaf.offset.line - 1;
    for (let line = Math.min(localLine, rows.length - 1); line >= 0; line--) {
      const row = rows[line];
      if (row === undefined || row.length === 0) continue;
      const lineOffset = line === 0 ? leaf.offset.column : 0;
      let column: number | undefined;
      if (line < localLine) {
        // Rows from @jridgewell/trace-mapping are sorted by column; the last entry is greatest.
        column = row[row.length - 1]![0] + lineOffset;
      } else {
        const index = greatestSegmentIndexAtOrBefore(
          row,
          position.column - lineOffset,
        );
        if (index >= 0) column = row[index]![0] + lineOffset;
      }
      if (column === undefined) continue;
      const absoluteLine = leaf.offset.line + line + 1;
      if (
        matched === null ||
        absoluteLine > matched.line ||
        (absoluteLine === matched.line && column > matched.column)
      )
        matched = { line: absoluteLine, column };
      break;
    }
  }
  return matched;
};

/** Largest index in column-sorted `row` with `segment[0] <= targetColumn`, or `-1`. */
const greatestSegmentIndexAtOrBefore = (
  row: readonly SourceMapSegment[],
  targetColumn: number,
): number => {
  let low = 0;
  let high = row.length - 1;
  let best = -1;
  while (low <= high) {
    const mid = low + ((high - low) >> 1);
    if (row[mid]![0] <= targetColumn) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
};

/** First index in column-sorted `row` with `segment[0] === column`, or `-1`. */
const firstSegmentIndexAt = (
  row: readonly SourceMapSegment[],
  column: number,
): number => {
  let low = 0;
  let high = row.length - 1;
  let first = -1;
  while (low <= high) {
    const mid = low + ((high - low) >> 1);
    const value = row[mid]![0];
    if (value === column) {
      first = mid;
      high = mid - 1;
    } else if (value < column) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return first;
};
const originalMatch = (
  segment: Readonly<SourceMapSegment>,
  map: TraceMap,
  mapUrl: string,
  declarations: readonly SourceMapSourceDeclaration[],
  sourceBase: number,
  contentFactsCache: Map<
    number,
    { readonly utf8_sha256: string; readonly utf8_bytes: number }
  >,
): WebSourceMapReport["matches"][number] => {
  if (segment.length === 1) return { state: "generated-only" };
  const sourceIndex = sourceBase + segment[1];
  const declaration = declarations[sourceIndex];
  if (declaration === undefined)
    throw malformedInput(
      SOURCE_MAP_FORMAT,
      "Mapping references an absent source declaration.",
    );
  const original = { line: segment[2] + 1, column: segment[3] };
  const offset =
    declaration.content === null
      ? undefined
      : webSourceOffset(declaration.content, original);
  return {
    state: "mapped",
    flattened_source_index: sourceIndex,
    section_path: [...declaration.sectionPath],
    source_index: declaration.sourceIndex,
    reported_source: declaration.source,
    reported_source_root: declaration.root,
    resolved_url: resolveJavaScriptSourceMapUrl(
      declaration.source,
      declaration.root,
      mapUrl,
    ),
    ignored: declaration.ignored,
    content:
      declaration.content === null
        ? { state: "unavailable", reason: "sourcesContent-not-retained" }
        : (() => {
            let cached = contentFactsCache.get(sourceIndex);
            if (cached === undefined) {
              cached = {
                utf8_sha256: sha256Hex(declaration.content),
                utf8_bytes: Buffer.byteLength(declaration.content),
              };
              contentFactsCache.set(sourceIndex, cached);
            }
            return {
              state: "embedded" as const,
              text: declaration.content,
              utf8_sha256: cached.utf8_sha256,
              utf8_bytes: cached.utf8_bytes,
              representation:
                "UTF-8 encoding of decoded sourcesContent text" as const,
            };
          })(),
    original_position: {
      ...original,
      offset: offset ?? null,
      content_position:
        declaration.content === null
          ? "content-unavailable"
          : offset === undefined
            ? "outside-embedded-text"
            : "verified-in-embedded-text",
    },
    name: segment.length === 5 ? (map.names[segment[4]] ?? null) : null,
  };
};
