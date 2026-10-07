import { z } from "zod";
import { WEB_SOURCE_MAP_LIMITS } from "../../domain/webSourceLocation.js";

const leafSchema = z.object({
  version: z.literal(3),
  file: z.string().nullable().optional(),
  sourceRoot: z.string().nullable().optional(),
  sources: z.array(z.string().nullable()),
  sourcesContent: z.array(z.string().nullable()).nullable().optional(),
  names: z.array(z.string()).default([]),
  mappings: z.string().regex(/^[A-Za-z0-9+/,;]*$/u),
  ignoreList: z.array(z.number().int().min(0)).optional(),
  x_google_ignoreList: z.array(z.number().int().min(0)).optional(),
});
const mapHeaderSchema = z.object({
  version: z.literal(3),
  file: z.string().nullable().optional(),
  sections: z.unknown().optional(),
});
const sectionSchema = z.object({
  offset: z.object({
    line: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    column: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
  map: z.unknown().optional(),
  url: z.string().optional(),
});
const indexedSchema = z.object({
  version: z.literal(3),
  sections: z.array(sectionSchema),
});

type Offset = { readonly line: number; readonly column: number };
interface PendingMap {
  readonly value: unknown;
  readonly path: readonly number[];
  readonly offset: Offset;
  readonly stop: Offset | null;
}

/** A decoder-profile failure with an actionable producer constraint. */
export class SourceMapFormatFailure extends Error {
  constructor(
    readonly reason: "format" | "unsupported" | "limit",
    message: string,
  ) {
    super(message);
  }
}

/** Raw declaration identity, separate from flattened engine URL identity. */
export interface SourceMapSourceDeclaration {
  readonly sectionPath: readonly number[];
  readonly sourceIndex: number;
  readonly source: string | null;
  readonly root: string | null;
  readonly content: string | null;
  readonly ignored: boolean;
}

/** Validated leaf with absolute first-line offsets and its enclosing section boundary. */
export interface SourceMapLeaf {
  readonly map: z.output<typeof leafSchema>;
  readonly offset: Offset;
  readonly stop: Offset | null;
}

const compare = (a: Offset, b: Offset): number =>
  a.line - b.line || a.column - b.column;
const addOffset = (base: Offset, offset: Offset): Offset => {
  const result = {
    line: base.line + offset.line,
    column: offset.column + (offset.line === 0 ? base.column : 0),
  };
  if (
    !Number.isSafeInteger(result.line) ||
    !Number.isSafeInteger(result.column) ||
    result.line >= WEB_SOURCE_MAP_LIMITS.decodedRows
  )
    throw new SourceMapFormatFailure(
      "limit",
      "Indexed offset exceeds the 262144 generated-row decoder budget.",
    );
  return result;
};

const addSections = (node: PendingMap, pending: PendingMap[]): void => {
  const sections = indexedSchema.parse(node.value).sections;
  for (const [index, section] of sections.entries()) {
    const previous = sections[index - 1];
    if (previous !== undefined && compare(section.offset, previous.offset) <= 0)
      throw new SourceMapFormatFailure(
        "format",
        "Indexed section offsets must be strictly increasing.",
      );
    if (section.url !== undefined)
      throw new SourceMapFormatFailure(
        "unsupported",
        `External source-map section URL is not fetched: ${section.url}`,
      );
    if (section.map === undefined)
      throw new SourceMapFormatFailure(
        "format",
        "Indexed section requires an embedded map.",
      );
  }
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index];
    if (section === undefined) continue;
    const next = sections[index + 1];
    const nextOffset =
      next === undefined ? null : addOffset(node.offset, next.offset);
    const stop =
      nextOffset === null
        ? node.stop
        : node.stop === null || compare(nextOffset, node.stop) < 0
          ? nextOffset
          : node.stop;
    const offset = addOffset(node.offset, section.offset);
    if (node.stop !== null && compare(offset, node.stop) >= 0)
      throw new SourceMapFormatFailure(
        "format",
        "Nested source-map section overlaps its enclosing boundary.",
      );
    pending.push({
      value: section.map,
      path: [...node.path, index],
      offset,
      stop,
    });
  }
};

const inspectMappingLayout = (
  mappings: string,
): { lines: number; segments: number } => {
  let lines = 1;
  let segments = 0;
  let components = 0;
  let inSegment = false;
  let continued = false;
  let digits = 0;
  const finish = (): void => {
    if (continued)
      throw new SourceMapFormatFailure(
        "format",
        "Source-map VLQ ends with an unfinished continuation.",
      );
    if (inSegment && ![1, 4, 5].includes(components))
      throw new SourceMapFormatFailure(
        "format",
        "Source-map segment requires one, four or five VLQ components.",
      );
  };
  for (const character of mappings) {
    if (character === "," || character === ";") {
      finish();
      inSegment = false;
      components = 0;
      if (character === ";") lines += 1;
    } else {
      digits += 1;
      if (
        (digits === 7 && !/[A-Dg-j]/u.test(character)) ||
        (digits > 7 && character !== "A" && character !== "g")
      )
        throw new SourceMapFormatFailure(
          "format",
          "Source-map VLQ exceeds the format's 32-bit quantity representation.",
        );
      if (!inSegment) segments += 1;
      inSegment = true;
      continued = /[g-z0-9+/]/u.test(character);
      if (!continued) {
        components += 1;
        digits = 0;
      }
    }
    if (
      segments > WEB_SOURCE_MAP_LIMITS.decodedSegments ||
      lines > WEB_SOURCE_MAP_LIMITS.decodedRows
    )
      throw new SourceMapFormatFailure(
        "limit",
        "Source-map layout exceeds the 262144 segment/generated-row decoder budget.",
      );
  }
  finish();
  return { lines, segments };
};

/** Validate structure before allocation, retaining raw declarations and section boundaries. */
export const inspectSourceMap = (
  text: string,
): {
  readonly jsonText: string;
  readonly format: "regular" | "indexed";
  readonly reportedFile: string | null;
  readonly declarations: readonly SourceMapSourceDeclaration[];
  readonly leaves: readonly SourceMapLeaf[];
} => {
  const withoutBom = text.replace(/^\uFEFF/u, "");
  const jsonText = withoutBom.startsWith(")]}'")
    ? withoutBom.slice(withoutBom.indexOf("\n") + 1)
    : withoutBom;
  const value: unknown = JSON.parse(jsonText);
  const root = mapHeaderSchema.parse(value);
  const declarations: SourceMapSourceDeclaration[] = [];
  const leaves: SourceMapLeaf[] = [];
  const pending: PendingMap[] = [
    { value, path: [], offset: { line: 0, column: 0 }, stop: null },
  ];
  let segmentCount = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (node.path.length > WEB_SOURCE_MAP_LIMITS.sectionDepth)
      throw new SourceMapFormatFailure(
        "limit",
        "Indexed source-map nesting exceeds the 64-level decoder stack budget.",
      );
    if (mapHeaderSchema.parse(node.value).sections !== undefined) {
      addSections(node, pending);
      continue;
    }
    const leaf = leafSchema.parse(node.value);
    const layout = inspectMappingLayout(leaf.mappings);
    segmentCount += layout.segments;
    if (
      segmentCount > WEB_SOURCE_MAP_LIMITS.decodedSegments ||
      node.offset.line + layout.lines > WEB_SOURCE_MAP_LIMITS.decodedRows
    )
      throw new SourceMapFormatFailure(
        "limit",
        "Source-map layout exceeds the 262144 segment/generated-row decoder budget.",
      );
    leaves.push({ map: leaf, offset: node.offset, stop: node.stop });
    for (const [sourceIndex, source] of leaf.sources.entries())
      declarations.push({
        sectionPath: node.path,
        sourceIndex,
        source,
        root: leaf.sourceRoot ?? null,
        content: leaf.sourcesContent?.[sourceIndex] ?? null,
        ignored: (leaf.ignoreList ?? leaf.x_google_ignoreList ?? []).includes(
          sourceIndex,
        ),
      });
  }
  // Absolute leaves adapt nested first-line column offsets before upstream AnyMap.
  // Raw map bytes and the original section/source identities are retained separately.
  const normalized =
    root.sections === undefined
      ? leaves[0]?.map
      : {
          version: 3,
          sections: leaves.map((leaf) => ({
            offset: leaf.offset,
            map: leaf.map,
          })),
        };
  return {
    jsonText: JSON.stringify(normalized),
    format: root.sections === undefined ? "regular" : "indexed",
    reportedFile: root.file ?? null,
    declarations,
    leaves,
  };
};
