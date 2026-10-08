import { TraceMap, decodedMappings } from "@jridgewell/trace-mapping";
import {
  SourceMapFormatFailure,
  type SourceMapLeaf,
} from "./SourceMapFormat.js";

/** Determine whether a leaf-local mapping falls before its enclosing boundary. */
export const isBeforeSourceMapLeafStop = (
  leaf: SourceMapLeaf,
  line: number,
  column: number,
): boolean => {
  if (leaf.stop === null) return true;
  const generatedLine = leaf.offset.line + line;
  const generatedColumn = column + (line === 0 ? leaf.offset.column : 0);
  return (
    generatedLine < leaf.stop.line ||
    (generatedLine === leaf.stop.line && generatedColumn < leaf.stop.column)
  );
};

/** Resolve one declaration with the same pinned upstream implementation used by full maps. */
export const resolveSourceMapSource = (
  source: string | null,
  sourceRoot: string | null | undefined,
  mapUrl: string,
): string => {
  const map = new TraceMap(
    {
      version: 3,
      names: [],
      sources: [source ?? ""],
      ...(sourceRoot == null ? {} : { sourceRoot }),
      mappings: "",
    },
    mapUrl,
  );
  const resolved = map.resolvedSources[0];
  if (resolved === undefined)
    throw new SourceMapFormatFailure(
      "format",
      "Source-map resolver did not return the requested source identity.",
    );
  return resolved;
};

/** Decode leaf mappings and validate producer indices before any consumer publishes them. */
export const decodeValidatedSourceMapLeaves = (
  leaves: readonly SourceMapLeaf[],
  mapUrl: string,
  check?: () => void,
): readonly {
  readonly leaf: SourceMapLeaf;
  readonly rows: ReturnType<typeof decodedMappings>;
  readonly resolvedSources: readonly string[];
}[] =>
  leaves.map((leaf) => {
    check?.();
    const map = new TraceMap(JSON.stringify(leaf.map), mapUrl);
    const rows = decodedMappings(map);
    for (const [line, row] of rows.entries()) {
      if ((line & 255) === 0) check?.();
      for (const segment of row) {
        const generatedLine = leaf.offset.line + line;
        const generatedColumn =
          segment[0] + (line === 0 ? leaf.offset.column : 0);
        if (
          !Number.isSafeInteger(generatedLine) ||
          !Number.isSafeInteger(generatedColumn) ||
          ![1, 4, 5].includes(segment.length) ||
          segment.some((value) => !Number.isSafeInteger(value) || value < 0) ||
          (segment.length !== 1 && segment[1] >= leaf.map.sources.length) ||
          (segment.length === 5 && segment[4] >= leaf.map.names.length)
        )
          throw new SourceMapFormatFailure(
            "format",
            "Decoded local or absolute position, source index or name index is invalid.",
          );
      }
    }
    return { leaf, rows, resolvedSources: map.resolvedSources };
  });
