/** Artifact source declarations do not require generated-position decoding. */
type SourceMapRecord = Readonly<Record<string, unknown>>;

/**
 * Return the JSON parsing view of retained source-map text. ECMA-426 permits
 * HTTP responses to start with `)]}'`; the first line is transport framing.
 * Keep the original text for artifact identity and Evidence provenance.
 * https://tc39.es/ecma426/#sec-fetchsourcemap
 */
export const sourceMapJsonText = (text: string): string => {
  const withoutBom = text.replace(/^\uFEFF/u, "");
  if (!withoutBom.startsWith(")]}'")) return withoutBom;
  const newline = withoutBom.search(/[\r\n]/u);
  return newline === -1 ? "" : withoutBom.slice(newline);
};

const isRecord = (value: unknown): value is SourceMapRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a parsed value has the version-3 map shape. */
const isVersion3Map = (value: unknown): value is SourceMapRecord =>
  isRecord(value) && value.version === 3;

/**
 * Collect leaf maps from an indexed source-map envelope, or undefined when
 * the envelope is not a version-3 map. A map carrying neither `mappings`
 * nor `sections` yields itself as the single leaf; callers decide whether
 * that leaf is valid content.
 */
export const flattenSourceMapLeaves = (
  root: unknown,
): readonly SourceMapRecord[] | undefined => {
  if (!isVersion3Map(root)) return undefined;
  const leaves: SourceMapRecord[] = [];
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const map = pending.pop();
    if (!isVersion3Map(map)) return undefined;
    if (Array.isArray(map.sections)) {
      for (let index = map.sections.length - 1; index >= 0; index -= 1) {
        const section = map.sections[index];
        if (!isRecord(section) || !isRecord(section.map)) return undefined;
        pending.push(section.map);
      }
    } else leaves.push(map);
  }
  return leaves;
};
