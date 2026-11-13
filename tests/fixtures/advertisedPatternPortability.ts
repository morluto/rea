/**
 * Detect advertised JSON Schema `pattern` values that a strict client can
 * reject even though V8 compiles them.
 *
 * The defect this guards against shipped in 6.9.0: `localPathStringSchema`
 * advertised `^[^\uD800-\uDFFF]*$`. It compiles in Annex B, `u` and `v` mode,
 * so the compile-only guard beside it passed, but a gateway that decodes the
 * escape into its own regex syntax rejected the pattern and with it the whole
 * `tools/list` request.
 *
 * Two properties make a pattern unsafe to advertise, and both are decidable
 * from the pattern text:
 *
 * 1. It names a code point inside U+D800..U+DFFF. A validator that resolves the
 *    escape and refuses surrogate code points rejects the pattern. `\uD800`,
 *    `\u{D800}` and `\x{D800}` all name one.
 * 2. Its meaning depends on the `u`/`v` flags. JSON Schema does not state the
 *    flags a validator compiles a pattern with, so a pattern whose meaning
 *    changes without `u` is not portable. `\p{Cs}` is the concrete case: under
 *    `u` it names surrogates, and without `u` Annex B reads it as the literal
 *    characters `p`, `{`, `C`, `s`, `}`.
 */

const SURROGATE_MIN = 0xd800;
const SURROGATE_MAX = 0xdfff;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isSurrogate = (codePoint: number): boolean =>
  codePoint >= SURROGATE_MIN && codePoint <= SURROGATE_MAX;

const describe = (codePoint: number): string =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

/** Escape spellings that can appear inside an advertised pattern. */
const CODEPOINT_ESCAPE =
  /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x\{([0-9a-fA-F]+)\}|\\x([0-9a-fA-F]{2})/gu;

/** Unicode property escapes, which are only defined with the `u` or `v` flag. */
const PROPERTY_ESCAPE = /\\[pP]\{([^}]*)\}/gu;

/** Property values whose meaning is the surrogate block. */
const SURROGATE_PROPERTIES = new Set(["cs", "surrogate", "surrogates"]);

export interface AdvertisedPatternFinding {
  readonly pattern: string;
  readonly reason: string;
}

const codePointFindings = (pattern: string): readonly string[] => {
  const findings: string[] = [];
  for (const match of pattern.matchAll(CODEPOINT_ESCAPE)) {
    const parsed = Number.parseInt(
      match[1] ?? match[2] ?? match[3] ?? match[4] ?? "",
      16,
    );
    if (!Number.isFinite(parsed)) continue;
    if (!isSurrogate(parsed)) continue;
    findings.push(
      `names surrogate code point ${describe(parsed)} via ${match[0]}`,
    );
  }
  return findings;
};

const propertyFindings = (pattern: string): readonly string[] => {
  const findings: string[] = [];
  for (const match of pattern.matchAll(PROPERTY_ESCAPE)) {
    const property = (match[1] ?? "").trim().toLowerCase();
    // Without `u`, Annex B reads `\p{...}` as literal characters, so any
    // property escape is mode-dependent. A surrogate-valued property is also a
    // code-point problem even when a client compiles with `u`.
    if (SURROGATE_PROPERTIES.has(property))
      findings.push(
        `${match[0]} is a surrogate property and is only defined with the u flag`,
      );
    else findings.push(`${match[0]} is only defined with the u or v flag`);
  }
  return findings;
};

/** Return every reason `pattern` is unsafe to publish, or an empty list. */
export const advertisedPatternFindings = (
  pattern: string,
): readonly string[] => [
  ...codePointFindings(pattern),
  ...propertyFindings(pattern),
];

/** Collect every `pattern` string in a schema document, with its location. */
export const collectAdvertisedPatterns = (
  schema: unknown,
  path = "$",
  found: { pattern: string; where: string }[] = [],
): { pattern: string; where: string }[] => {
  if (Array.isArray(schema)) {
    schema.forEach((entry, index) =>
      collectAdvertisedPatterns(entry, `${path}[${index}]`, found),
    );
    return found;
  }
  if (!isRecord(schema)) return found;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "pattern" && typeof value === "string")
      found.push({ pattern: value, where: `${path}/pattern` });
    else collectAdvertisedPatterns(value, `${path}/${key}`, found);
  }
  return found;
};
