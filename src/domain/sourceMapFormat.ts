import { z } from "zod";
import {
  WEB_SOURCE_MAP_LIMITS,
  sourceMapLimitRecovery,
  type SourceMapLimitSelection,
  type SourceMapLimits,
} from "./sourceMapLimits.js";
import {
  malformedInput,
  ParseFailureError,
  type ParseFailure,
  type ParseFailureKind,
  unsupportedInput,
} from "./parseFailure.js";
import {
  classifySourceMapSection,
  classifySourceMapSections,
  sourceMapJsonText,
  isVersion3Map,
} from "./sourceMapEnvelope.js";
import type {
  ExternalSourceMapSection,
  InvalidSourceMapSection,
} from "./sourceMapEnvelope.js";
import type { EncodedSourceMapXInput } from "@jridgewell/trace-mapping";

const sourceNameSchema = z.string().nullable();
const sourceRootSchema = sourceNameSchema.optional();
// A missing slot leaves that declaration without content. Extra slots
// contribute no extra sources (ECMA-426 DecodeSourceMapSources).
const sourceContentsSchema = z.array(sourceNameSchema).nullable().optional();

const leafSchema = z.object({
  version: z.literal(3),
  file: z.string().nullable().optional(),
  sourceRoot: sourceRootSchema,
  sources: z.array(sourceNameSchema),
  sourcesContent: sourceContentsSchema,
  names: z.array(z.string()).default([]),
  mappings: z.string().regex(/^[A-Za-z0-9+/,;]*$/u),
  ignoreList: z.array(z.int().min(0)).optional(),
  x_google_ignoreList: z.array(z.int().min(0)).optional(),
});
const mapHeaderSchema = z.object({
  version: z.literal(3),
  file: z.string().nullable().optional(),
  sections: z.unknown().optional(),
});
const sectionOffsetSchema = z.object({
  offset: z.object({
    line: z.int().min(0),
    column: z.int().min(0),
  }),
});
type Offset = z.output<typeof sectionOffsetSchema>["offset"];
type RawMap = Readonly<Record<string, unknown>>;
interface PendingMap {
  readonly value: RawMap;
  readonly path: readonly number[];
  readonly offset: Offset | null;
  readonly stop: Offset | null;
}

interface PartialStructure {
  readonly invalid: (path: readonly number[], failure: ParseFailure) => void;
  readonly external: (section: ExternalSourceMapSection) => void;
  readonly leaf: (
    node: PendingMap,
    failure: ParseFailure,
    unpositionedMap?: z.output<typeof leafSchema>,
  ) => void;
}

/** Aggregate structural work shared by maps in one selected inspection. */
export interface SourceMapStructureBudget {
  records: number;
}

export interface SourceMapStructureOptions {
  readonly profile?: "browser-collection";
  readonly limits?: SourceMapLimits;
  readonly budget?: SourceMapStructureBudget;
  readonly check?: () => void;
}

/** The ParseFailure format of source maps and their indexed sections. */
export const SOURCE_MAP_FORMAT = "source-map";

/** The ParseFailure field of embedded mappings that cross a section boundary. */
const SECTION_BOUNDARY = "section-boundary";

/** A source-map decoder failure; any other cause is not one. */
export const isSourceMapFailure = (
  cause: unknown,
): cause is ParseFailureError =>
  cause instanceof ParseFailureError &&
  cause.failure.format === SOURCE_MAP_FORMAT;

/** A caller-selectable source-map allowance refused the input. */
export const isSourceMapLimit = (
  cause: unknown,
): cause is ParseFailureError<"limit"> =>
  isSourceMapFailure(cause) && cause.failure.kind === "limit";

/** Embedded mappings overlap the following section; its message is public. */
export const isSourceMapSectionOverlap = (
  cause: unknown,
): cause is ParseFailureError<"malformed"> =>
  isSourceMapFailure(cause) && cause.failure.field === SECTION_BOUNDARY;

export const sourceMapSectionOverlap = (
  detail: string,
): ParseFailureError<"malformed"> =>
  malformedInput(SOURCE_MAP_FORMAT, detail, { field: SECTION_BOUNDARY });

/** The selected allowance `name` stopped decoding; the detail names its recovery. */
export const sourceMapLimitFailure = (
  summary: string,
  name: keyof SourceMapLimitSelection,
  maximum: number,
): ParseFailureError<"limit"> =>
  new ParseFailureError({
    kind: "limit",
    format: SOURCE_MAP_FORMAT,
    detail: `${summary} ${sourceMapLimitRecovery(name, maximum)}`,
    limit: { name, maximum },
  });

/** Report schema rejection through the one failure type consumers classify. */
const parseStructure = <Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw malformedInput(SOURCE_MAP_FORMAT, parsed.error.message);
};

/** Raw declaration identity, separate from flattened engine URL identity. */
export interface SourceMapSourceDeclaration extends LocalSourceMapDeclaration {
  readonly ignored: boolean;
}

/** Validated leaf with absolute first-line offsets and its enclosing section boundary. */
export interface SourceMapLeaf {
  readonly map: z.output<typeof leafSchema>;
  readonly codecMap: EncodedSourceMapXInput;
  readonly offset: Offset;
  readonly stop: Offset | null;
}

const codecLeaf = (
  map: z.output<typeof leafSchema>,
): EncodedSourceMapXInput => ({
  version: 3,
  ...(map.file === undefined ? {} : { file: map.file }),
  ...(typeof map.sourceRoot === "string" ? { sourceRoot: map.sourceRoot } : {}),
  sources: map.sources,
  ...(map.sourcesContent == null ? {} : { sourcesContent: map.sourcesContent }),
  names: map.names,
  mappings: map.mappings,
  ...(map.ignoreList === undefined ? {} : { ignoreList: map.ignoreList }),
  ...(map.x_google_ignoreList === undefined
    ? {}
    : { x_google_ignoreList: map.x_google_ignoreList }),
});

const compare = (a: Offset, b: Offset): number =>
  a.line - b.line || a.column - b.column;
const addOffset = (
  base: Offset,
  offset: Offset,
  limits: SourceMapLimits,
): Offset => {
  const result = {
    line: base.line + offset.line,
    column: offset.column + (offset.line === 0 ? base.column : 0),
  };
  if (
    !Number.isSafeInteger(result.line) ||
    !Number.isSafeInteger(result.column) ||
    result.line >= limits.decodedRows
  )
    throw sourceMapLimitFailure(
      `Indexed offset exceeds the generated-row decoder budget.`,
      "decoded_rows",
      limits.decodedRows,
    );
  return result;
};

const consumeRecords = (
  budget: { records: number },
  limits: SourceMapLimits,
  count: number,
): void => {
  if (count > limits.decodedRecords - budget.records)
    throw sourceMapLimitFailure(
      `Source-map structure exceeds the decoder budget.`,
      "decoded_records",
      limits.decodedRecords,
    );
  budget.records += count;
};

/** Keep format failures as partial facts only when the selected reader supports them. */
const recoverStructure = <Value>(
  read: () => Value,
  path: readonly number[],
  partial: PartialStructure | undefined,
): Value | null => {
  try {
    return read();
  } catch (failure) {
    if (partial === undefined || !isSourceMapFailure(failure)) throw failure;
    partial.invalid(path, failure.failure);
    return null;
  }
};

const addSections = ({
  node,
  pending,
  rawSections,
  budget,
  options,
  partial,
}: {
  readonly node: PendingMap;
  readonly pending: PendingMap[];
  readonly rawSections: readonly unknown[];
  readonly budget: SourceMapStructureBudget;
  readonly options: SourceMapStructureOptions;
  readonly partial: PartialStructure | undefined;
}): void => {
  const limits = options.limits ?? WEB_SOURCE_MAP_LIMITS;
  options.check?.();
  if (
    recoverStructure(
      () => consumeRecords(budget, limits, rawSections.length),
      node.path,
      partial,
    ) === null
  )
    return;
  const offsets = rawSections.map((section, index) => {
    if ((index & 255) === 0) options.check?.();
    return recoverStructure(
      () => parseStructure(sectionOffsetSchema, section).offset,
      [...node.path, index],
      partial,
    );
  });
  const maps: (RawMap | null)[] = [];
  let previous: Offset | null = null;
  for (const [index, section] of rawSections.entries()) {
    if ((index & 255) === 0) options.check?.();
    const path = [...node.path, index];
    const offset = offsets[index] ?? null;
    if (offset !== null && previous !== null && compare(offset, previous) < 0) {
      const failure = malformedInput(
        SOURCE_MAP_FORMAT,
        "Indexed section offsets must be in nondecreasing order.",
      );
      if (partial === undefined) throw failure;
      partial.invalid(path, failure.failure);
      offsets[index] = null;
    }
    if (offset !== null) previous = offset;

    const classification = classifySourceMapSection(section);
    if (classification.kind === "external") {
      if (partial === undefined)
        throw unsupportedInput(
          SOURCE_MAP_FORMAT,
          `External source-map section URL is not fetched: ${classification.url}`,
        );
      partial.external({ section_path: path, url: classification.url });
    } else if (classification.kind === "invalid") {
      if (partial === undefined)
        throw malformedInput(
          SOURCE_MAP_FORMAT,
          `${classification.reason} Section path: ${JSON.stringify(path)}.`,
        );
      partial.invalid(
        path,
        malformedInput(SOURCE_MAP_FORMAT, classification.reason).failure,
      );
    }
    maps.push(classification.kind === "embedded" ? classification.map : null);
  }

  // Validate section syntax and ownership before applying generated-row limits.
  let nextOffset: Offset | null = null;
  for (let index = maps.length - 1; index >= 0; index -= 1) {
    if ((index & 255) === 0) options.check?.();
    const path = [...node.path, index];
    const declared = offsets[index];
    const base = node.offset;
    const offset =
      declared == null || base === null
        ? null
        : recoverStructure(
            () => addOffset(base, declared, limits),
            path,
            partial,
          );
    const stop =
      nextOffset === null
        ? node.stop
        : node.stop === null || compare(nextOffset, node.stop) < 0
          ? nextOffset
          : node.stop;
    const map = maps[index];
    if (map != null) pending.push({ value: map, path, offset, stop });
    nextOffset = offset;
  }
};

const inspectMappingLayout = (
  mappings: string,
  limits: SourceMapLimits,
  check?: () => void,
): { lines: number; segments: number } => {
  let lines = 1;
  let segments = 0;
  let components = 0;
  let inSegment = false;
  let afterComma = false;
  let continued = false;
  let digits = 0;
  const finish = (requiresSegment: boolean): void => {
    if (requiresSegment && !inSegment)
      throw malformedInput(
        SOURCE_MAP_FORMAT,
        "Source-map mappings contain an empty mapping segment.",
      );
    if (continued)
      throw malformedInput(
        SOURCE_MAP_FORMAT,
        "Source-map VLQ ends with an unfinished continuation.",
      );
    if (inSegment && ![1, 4, 5].includes(components))
      throw malformedInput(
        SOURCE_MAP_FORMAT,
        "Source-map segment requires one, four or five VLQ components.",
      );
  };
  let index = 0;
  for (const character of mappings) {
    if ((index++ & 0x3fff) === 0) check?.();
    if (character === "," || character === ";") {
      const isComma = character === ",";
      finish(isComma || afterComma);
      afterComma = isComma;
      inSegment = false;
      components = 0;
      if (character === ";") lines += 1;
    } else {
      digits += 1;
      if (
        (digits === 7 && !/[A-Dg-j]/u.test(character)) ||
        (digits > 7 && character !== "A" && character !== "g")
      )
        throw malformedInput(
          SOURCE_MAP_FORMAT,
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
    if (segments > limits.decodedSegments || lines > limits.decodedRows)
      throw sourceMapLimitFailure(
        `Source-map layout exceeds decoder admission.`,
        segments > limits.decodedSegments ? "decoded_segments" : "decoded_rows",
        segments > limits.decodedSegments
          ? limits.decodedSegments
          : limits.decodedRows,
      );
  }
  finish(afterComma);
  return { lines, segments };
};

const admitLeafFields = (
  value: RawMap,
  budget: SourceMapStructureBudget,
  options: SourceMapStructureOptions,
): void => {
  const limits = options.limits ?? WEB_SOURCE_MAP_LIMITS;
  options.check?.();
  consumeRecords(budget, limits, 1);
  for (const field of ["sources", "names", "sourcesContent"] as const) {
    const raw = value[field];
    if (Array.isArray(raw)) consumeRecords(budget, limits, raw.length);
  }
  options.check?.();
};

const inspectLeaf = (
  value: RawMap,
  budget: SourceMapStructureBudget,
  options: SourceMapStructureOptions,
): { map: z.output<typeof leafSchema>; lines: number } => {
  const limits = options.limits ?? WEB_SOURCE_MAP_LIMITS;
  const map = parseStructure(leafSchema, value);
  const { lines, segments } = inspectMappingLayout(
    map.mappings,
    limits,
    options.check,
  );
  consumeRecords(budget, limits, segments + lines);
  return { map, lines };
};

/** Shared bounded walk. Only position-based consumers require offsets for every leaf. */
const walkSourceMapStructure = (
  value: RawMap,
  options: SourceMapStructureOptions,
  leaf: (node: PendingMap, map: z.output<typeof leafSchema>) => void,
  partial?: PartialStructure,
): void => {
  const limits = options.limits ?? WEB_SOURCE_MAP_LIMITS;
  const pending: PendingMap[] = [
    { value, path: [], offset: { line: 0, column: 0 }, stop: null },
  ];
  const budget = options.budget ?? { records: 0 };
  while (pending.length > 0) {
    options.check?.();
    const node = pending.pop();
    if (node === undefined) break;
    if (node.path.length > limits.sectionDepth) {
      const failure = sourceMapLimitFailure(
        "Indexed source-map nesting exceeds decoder admission.",
        "section_depth",
        limits.sectionDepth,
      );
      if (partial === undefined) throw failure;
      partial.invalid(node.path, failure.failure);
      continue;
    }
    const sections = classifySourceMapSections(node.value);
    if (sections.kind === "invalid") {
      const failure = malformedInput(SOURCE_MAP_FORMAT, sections.reason);
      if (partial === undefined) throw failure;
      partial.invalid(node.path, failure.failure);
    } else if (sections.kind === "indexed") {
      addSections({
        node,
        pending,
        rawSections: sections.sections,
        budget,
        options,
        partial,
      });
    } else {
      if (
        recoverStructure(
          () => admitLeafFields(node.value, budget, options),
          node.path,
          partial,
        ) === null
      )
        continue;
      let admitted: ReturnType<typeof inspectLeaf>;
      try {
        admitted = inspectLeaf(node.value, budget, options);
      } catch (failure) {
        if (partial === undefined || !isSourceMapFailure(failure))
          throw failure;
        partial.leaf(node, failure.failure);
        continue;
      }
      // A valid leaf can exceed the positioned row allowance without losing
      // its bounded source declarations.
      if (
        node.offset !== null &&
        node.offset.line + admitted.lines > limits.decodedRows
      ) {
        const failure = sourceMapLimitFailure(
          "Source-map layout exceeds decoder admission.",
          "decoded_rows",
          limits.decodedRows,
        );
        if (partial === undefined) throw failure;
        partial.leaf(node, failure.failure, admitted.map);
        continue;
      }
      leaf(node, admitted.map);
    }
  }
};

const observeSourceDeclarations = (
  path: readonly number[],
  map: z.output<typeof leafSchema>,
  observe: (declaration: SourceMapSourceDeclaration) => void,
): void => {
  const ignoredSources = new Set(
    map.ignoreList ?? map.x_google_ignoreList ?? [],
  );
  for (const [sourceIndex, source] of map.sources.entries())
    observe({
      sectionPath: path,
      sourceIndex,
      source,
      root: map.sourceRoot ?? null,
      content: map.sourcesContent?.[sourceIndex] ?? null,
      ignored: ignoredSources.has(sourceIndex),
    });
};

/** Validate structure before allocation, retaining raw declarations and section boundaries. */
export const inspectSourceMap = (
  text: string,
  options: SourceMapStructureOptions = {},
): ReturnType<typeof inspectSourceMapValue> => {
  const jsonText = sourceMapJsonText(text);
  const value: unknown = JSON.parse(jsonText);
  return inspectSourceMapValue(value, options);
};

/** Return validated leaves when a consumer needs decoded rows after preflight. */
export const inspectSourceMapValue = (
  value: unknown,
  options: SourceMapStructureOptions = {},
): {
  readonly format: "regular" | "indexed";
  readonly reportedFile: string | null;
  readonly declarations: readonly SourceMapSourceDeclaration[];
  readonly leaves: readonly SourceMapLeaf[];
} => {
  options.check?.();
  const root = parseStructure(mapHeaderSchema, value);
  const declarations: SourceMapSourceDeclaration[] = [];
  const leaves: SourceMapLeaf[] = [];
  if (!isVersion3Map(value))
    throw new TypeError("Validated source map is unavailable");
  walkSourceMapStructure(value, options, (node, leaf) => {
    if (node.offset === null)
      throw new TypeError("Validated source-map offset is unavailable");
    leaves.push({
      map: leaf,
      codecMap: codecLeaf(leaf),
      offset: node.offset,
      stop: node.stop,
    });
    if (options.profile !== "browser-collection")
      observeSourceDeclarations(node.path, leaf, (declaration) =>
        declarations.push(declaration),
      );
  });
  return {
    format: root.sections === undefined ? "regular" : "indexed",
    reportedFile: root.file ?? null,
    declarations,
    leaves,
  };
};

export interface LocalSourceMapDeclaration {
  readonly sectionPath: readonly number[];
  readonly sourceIndex: number;
  readonly source: string | null;
  readonly root: string | null;
  readonly content: string | null;
}

const localFailureDetail = (failure: ParseFailure): string =>
  failure.kind === "limit"
    ? `Local source-map inspection exceeded ${failure.limit.name} (${String(failure.limit.maximum)}).`
    : failure.detail;

const recoverSourceDeclarations = (
  node: PendingMap,
  failure: ParseFailure,
  declarations: LocalSourceMapDeclaration[],
  limitations: string[],
): void => {
  const map = node.value;
  const start = limitations.length;
  const location =
    node.path.length === 0 ? "" : ` in section [${node.path.join(",")}]`;
  const names = map.sources;
  if (!Array.isArray(names)) {
    limitations.push(`Source map has no sources array${location}.`);
    return;
  }
  const contents = sourceContentsSchema.safeParse(map.sourcesContent);
  if (!contents.success)
    limitations.push(
      `Source map sourcesContent must be an array of strings or null entries${location}.`,
    );
  const root = sourceRootSchema.safeParse(map.sourceRoot);
  if (!root.success) {
    limitations.push(
      `Source map sourceRoot must be a string or null${location}.`,
    );
    return;
  }
  for (const [sourceIndex, value] of names.entries()) {
    const source = sourceNameSchema.safeParse(value);
    if (!source.success) {
      limitations.push(
        `Source map contains a non-string source name at index ${String(sourceIndex)}${location}.`,
      );
      continue;
    }
    const content = Array.isArray(map.sourcesContent)
      ? sourceNameSchema.safeParse(map.sourcesContent[sourceIndex])
      : undefined;
    declarations.push({
      sectionPath: node.path,
      sourceIndex,
      source: source.data,
      root: root.data ?? null,
      content: content?.success ? content.data : null,
    });
  }
  if (typeof map.mappings !== "string")
    limitations.push(`Source map has no mappings string${location}.`);
  if (limitations.length === start)
    limitations.push(
      `Source map structure is invalid${location}: ${localFailureDetail(failure)}`,
    );
};

interface LocalSourceMapFacts {
  readonly declarations: readonly LocalSourceMapDeclaration[];
  readonly limitations: readonly string[];
  readonly external_sections: readonly ExternalSourceMapSection[];
  readonly invalid_sections: readonly InvalidSourceMapSection[];
}

/** Read only local source declarations. Missing or invalid generated coordinates stay unresolved. */
export const inspectLocalSourceMapDeclarations = (
  text: string,
  options: Pick<SourceMapStructureOptions, "limits" | "check"> = {},
): LocalSourceMapFacts => {
  const declarations: LocalSourceMapDeclaration[] = [];
  const limitations: string[] = [];
  const external: ExternalSourceMapSection[] = [];
  const invalid: InvalidSourceMapSection[] = [];
  const unreadable = (limitation: string): LocalSourceMapFacts => ({
    declarations,
    limitations: [limitation],
    external_sections: external,
    invalid_sections: invalid,
  });
  options.check?.();
  let value: unknown;
  try {
    value = JSON.parse(sourceMapJsonText(text));
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    return unreadable("Source map is not valid JSON.");
  }
  if (!isVersion3Map(value))
    return unreadable("Source map is not a version 3 map.");

  const root = mapHeaderSchema.safeParse(value);
  if (!root.success)
    limitations.push("Source map reported file must be a string or null.");
  walkSourceMapStructure(
    value,
    options,
    (node, map) =>
      observeSourceDeclarations(node.path, map, (declaration) =>
        declarations.push(declaration),
      ),
    {
      invalid: (path, failure) =>
        invalid.push({
          section_path: path,
          reason: localFailureDetail(failure),
        }),
      external: (section) => external.push(section),
      leaf: (node, failure) =>
        recoverSourceDeclarations(node, failure, declarations, limitations),
    },
  );
  const comparePaths = (
    left: { section_path: readonly number[] },
    right: { section_path: readonly number[] },
  ): number => {
    for (const [index, segment] of left.section_path.entries()) {
      const other = right.section_path[index];
      if (other === undefined) return 1;
      if (segment !== other) return segment - other;
    }
    return left.section_path.length - right.section_path.length;
  };
  return {
    declarations,
    limitations,
    external_sections: external.sort(comparePaths),
    invalid_sections: invalid.sort(comparePaths),
  };
};

/** Recover observed source content without treating incomplete maps as absent. */
export const inspectSourceMapSourceContent = (
  text: string,
  options: Pick<SourceMapStructureOptions, "limits" | "check"> = {},
):
  | { readonly embedded: boolean; readonly complete: true }
  | {
      readonly embedded: boolean;
      readonly complete: false;
      readonly failure: ParseFailureError;
    } => {
  options.check?.();
  let value: unknown;
  try {
    value = JSON.parse(sourceMapJsonText(text));
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    return {
      embedded: false,
      complete: false,
      failure: new ParseFailureError<ParseFailureKind>({
        kind: "malformed",
        format: SOURCE_MAP_FORMAT,
        detail: cause.message,
      }),
    };
  }
  const hasContent = (
    inspection: ReturnType<typeof inspectSourceMapValue>,
  ): boolean =>
    inspection.declarations.some(
      (declaration) =>
        declaration.content !== null && declaration.content.length > 0,
    );
  try {
    return {
      embedded: hasContent(inspectSourceMapValue(value, options)),
      complete: true,
    };
  } catch (failure) {
    if (!isSourceMapFailure(failure)) throw failure;
    let embedded = false;
    const observe = (leaf: z.output<typeof leafSchema>): void => {
      embedded ||= leaf.sources.some(
        (_source, index) => (leaf.sourcesContent?.[index]?.length ?? 0) > 0,
      );
    };
    if (isVersion3Map(value))
      walkSourceMapStructure(value, options, (_node, leaf) => observe(leaf), {
        invalid: () => {},
        external: () => {},
        leaf: (_node, _failure, unpositionedMap) => {
          if (unpositionedMap !== undefined) observe(unpositionedMap);
        },
      });
    return { embedded, complete: false, failure };
  }
};
