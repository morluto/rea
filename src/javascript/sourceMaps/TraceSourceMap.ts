import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { getHeapStatistics } from "node:v8";
import {
  AnyMap,
  TraceMap,
  decodedMappings,
  type SourceMapSegment,
} from "@jridgewell/trace-mapping";
import { z } from "zod";
import { webSourceOffset } from "../../domain/webSourcePosition.js";
import {
  webSourceMapReportSchema,
  type WebSourceMapReport,
  WEB_SOURCE_MAP_LIMITS,
} from "../../domain/webSourceLocation.js";
import type { WebSourcePosition } from "../../domain/webSourcePosition.js";
import {
  inspectSourceMap,
  SourceMapFormatFailure,
  type SourceMapSourceDeclaration,
} from "./SourceMapFormat.js";

/** Decode with the pinned upstream codec; preserve every equal-position candidate. */
export const traceSourceMap = (
  text: string,
  url: string,
  position: WebSourcePosition,
): WebSourceMapReport => {
  const inspected = inspectSourceMap(text);
  const { map, rows } = decodeValidatedMap(inspected, url);
  const matched = greatestPosition(rows, position);
  const segments =
    matched === null
      ? []
      : (rows[matched.line - 1] ?? []).filter(
          (segment) => segment[0] === matched.column,
        );
  let bytes = 0;
  const matches: WebSourceMapReport["matches"] = [];
  for (const segment of segments) {
    const match = originalMatch(segment, map, inspected.declarations);
    bytes += Buffer.byteLength(JSON.stringify(match)) + 1;
    if (bytes > WEB_SOURCE_MAP_LIMITS.outputBytes)
      throw new SourceMapFormatFailure(
        "limit",
        "Complete source-map point evidence exceeds the 32 MiB output budget; no partial evidence was returned.",
      );
    matches.push(match);
  }
  const metadata: unknown = createRequire(import.meta.url)(
    "@jridgewell/trace-mapping/package.json",
  );
  const version = z
    .object({ version: z.string().min(1) })
    .parse(metadata).version;
  return webSourceMapReportSchema.parse({
    source_map_sha256: createHash("sha256").update(text).digest("hex"),
    url_context: url,
    engine: { id: "jridgewell-trace-mapping", version },
    runtime: {
      id: "node-v8",
      version: process.version,
      v8_heap_limit_bytes: getHeapStatistics().heap_size_limit,
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

const decodeValidatedMap = (
  inspected: ReturnType<typeof inspectSourceMap>,
  url: string,
) => {
  let regularRows: ReturnType<typeof decodedMappings> | undefined;
  for (const leaf of inspected.leaves) {
    const decoded = decodedMappings(
      new TraceMap(JSON.stringify(leaf.map), url),
    );
    if (inspected.format === "regular") regularRows = decoded;
    for (const [line, row] of decoded.entries())
      for (const segment of row) {
        if (
          segment.some((value) => !Number.isSafeInteger(value) || value < 0) ||
          (segment.length !== 1 && segment[1] >= leaf.map.sources.length) ||
          (segment.length === 5 && segment[4] >= leaf.map.names.length)
        )
          throw new SourceMapFormatFailure(
            "format",
            "Decoded section-local position, source index or name index is invalid.",
          );
        const generatedLine = leaf.offset.line + line;
        const generatedColumn =
          segment[0] + (line === 0 ? leaf.offset.column : 0);
        if (
          leaf.stop !== null &&
          (generatedLine > leaf.stop.line ||
            (generatedLine === leaf.stop.line &&
              generatedColumn >= leaf.stop.column))
        )
          throw new SourceMapFormatFailure(
            "format",
            "Embedded source-map mappings overlap the following section boundary.",
          );
      }
  }
  const map = new AnyMap(inspected.jsonText, url);
  const rows = regularRows ?? decodedMappings(map);
  for (const row of rows)
    for (const segment of row) {
      if (
        ![1, 4, 5].includes(segment.length) ||
        segment.some((v) => !Number.isSafeInteger(v) || v < 0) ||
        (segment.length !== 1 && segment[1] >= inspected.declarations.length) ||
        (segment.length === 5 && segment[4] >= map.names.length)
      )
        throw new SourceMapFormatFailure(
          "format",
          "Decoded mapping has invalid component count, position, source index or name index.",
        );
    }

  return { map, rows };
};

const greatestPosition = (
  rows: ReturnType<typeof decodedMappings>,
  position: WebSourcePosition,
): WebSourcePosition | null => {
  for (
    let line = Math.min(position.line - 1, rows.length - 1);
    line >= 0;
    line -= 1
  ) {
    let column: number | undefined;
    for (const segment of rows[line] ?? [])
      if (line < position.line - 1 || segment[0] <= position.column)
        column = segment[0];
    if (column !== undefined) return { line: line + 1, column };
  }
  return null;
};
const originalMatch = (
  segment: Readonly<SourceMapSegment>,
  map: TraceMap,
  declarations: readonly SourceMapSourceDeclaration[],
): WebSourceMapReport["matches"][number] => {
  if (segment.length === 1) return { state: "generated-only" };
  const declaration = declarations[segment[1]];
  if (declaration === undefined)
    throw new SourceMapFormatFailure(
      "format",
      "Mapping references an absent source declaration.",
    );
  const original = { line: segment[2] + 1, column: segment[3] };
  const offset =
    declaration.content === null
      ? undefined
      : webSourceOffset(declaration.content, original);
  return {
    state: "mapped",
    flattened_source_index: segment[1],
    section_path: [...declaration.sectionPath],
    source_index: declaration.sourceIndex,
    reported_source: declaration.source,
    reported_source_root: declaration.root,
    resolved_url:
      declaration.source === null
        ? null
        : (map.resolvedSources[segment[1]] ?? null),
    ignored: declaration.ignored,
    content:
      declaration.content === null
        ? { state: "unavailable", reason: "sourcesContent-not-retained" }
        : {
            state: "embedded",
            text: declaration.content,
            utf8_sha256: createHash("sha256")
              .update(declaration.content)
              .digest("hex"),
            utf8_bytes: Buffer.byteLength(declaration.content),
            representation: "UTF-8 encoding of decoded sourcesContent text",
          },
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
