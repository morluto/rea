/**
 * Structural walk over indexed source-map envelopes. Both the browser
 * source-map fetcher and the artifact source-map reader accept version-3
 * maps with recursively indexed `sections`; this module owns that walk so
 * the two validators cannot drift. Leaf content checks (mappings, sources,
 * names, contents) stay with the callers, which enforce different
 * strictness.
 */
type SourceMapRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is SourceMapRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a parsed value has the version-3 map shape. */
export const isVersion3Map = (value: unknown): value is SourceMapRecord =>
  isRecord(value) && value.version === 3;

const isValidOffset = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export interface FlattenSourceMapOptions {
  /** Require each section offset to carry safe-integer line/column. */
  readonly validateOffsets?: boolean;
}

/**
 * Collect leaf maps from an indexed source-map envelope, or undefined when
 * the envelope is not a version-3 map. A map carrying neither `mappings`
 * nor `sections` yields itself as the single leaf; callers decide whether
 * that leaf is valid content.
 */
export const flattenSourceMapLeaves = (
  root: unknown,
  options?: FlattenSourceMapOptions,
): readonly SourceMapRecord[] | undefined => {
  if (!isVersion3Map(root)) return undefined;
  const leaves: SourceMapRecord[] = [];
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const map = pending.pop();
    if (!isVersion3Map(map)) return undefined;
    if (Array.isArray(map.sections)) {
      for (const section of map.sections) {
        if (!isRecord(section) || !isRecord(section.map)) return undefined;
        if (options?.validateOffsets === true) {
          if (!isRecord(section.offset)) return undefined;
          if (
            !isValidOffset(section.offset.line) ||
            !isValidOffset(section.offset.column)
          )
            return undefined;
        }
        pending.push(section.map);
      }
    } else leaves.push(map);
  }
  return leaves;
};
