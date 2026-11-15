import {
  COMPACT_SCHEMA_MAX_DEPTH,
  schemaDepth,
  serializedBytes,
} from "./compactJsonSchema.js";
import {
  schemaArrays,
  schemaChildren,
  schemaMaps,
} from "./jsonSchemaKeywords.js";

// The portable advertised dialect: the subset of JSON Schema that every
// client and model gateway REA has been seen to meet accepts, and the regex
// grammar that compiles in V8 (plain, `u`, `v`), Python `re`, Go `regexp`
// (RE2), Rust `regex` and `fancy-regex`. One construct outside it can make a
// client refuse the complete tools request, not only the affected tool. The
// server still validates every call against the canonical contract, so a
// projection into this dialect may widen an advertised constraint but never
// narrow it. Each rule names the rejection that forces it.

/** One advertised construct outside the portable dialect. */
export interface AdvertisedDialectViolation {
  readonly tool: string;
  readonly schema: "tool" | "input" | "output";
  /** JSON path inside the selected schema; `$` is its root. */
  readonly path: string;
  readonly rule: AdvertisedDialectRule;
  /** The specific keyword, type or regex construct, when the rule has several. */
  readonly detail?: string;
}

export type AdvertisedDialectRule =
  // Bedrock caps names at 64 and clients prefix `mcp__rea__` (10 characters).
  | "tool-name"
  // Claude Code truncates a tool description at 4,096 characters.
  | "tool-description-length"
  // Moonshot rejects a parameters schema above its literal size cap (#1484).
  | "input-bytes"
  // OpenCode and Muse Spark reject nesting deeper than ten levels (#2813, #919).
  | "input-depth"
  // Anthropic and OpenAI require a plain object root without a combinator (#1052).
  | "root-shape"
  // Each keyword outside the allowlist is rejected by at least one target.
  | "keyword"
  // Gemini, Moonshot and Ark reject type lists and untyped nodes (#7103, #3800).
  | "type"
  // VS Code and OpenAI reject arrays without `items`; Gemini rejects `items`
  // beside a non-array type (#3576, #7103).
  | "array-items"
  // Gemini accepts only non-empty string enums (#4025, #5201).
  | "enum"
  // Root, empty or untyped unions, and unions beside properties (#3800).
  | "any-of"
  // VS Code truncates nested descriptions above 1,024 characters.
  | "description-length"
  // llama.cpp grammars fail at length and item bounds of 1,999 or more.
  | "bound"
  // Anthropic and Gemini property-name rules.
  | "property-name"
  // A pattern outside the portable regex grammar (#1329, #10348, #10389).
  | "pattern"
  // Codex turns `true` into a string schema.
  | "boolean-schema";

const ALLOWED_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "anyOf",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "pattern",
]);
const PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  "object",
  "array",
  "string",
  "integer",
  "number",
  "boolean",
]);
const TOOL_NAME = /^[a-z][a-z0-9_]{0,53}$/u;
const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const TOOL_DESCRIPTION_LIMIT = 4096;
const DESCRIPTION_LIMIT = 1024;
const BOUND_LIMIT = 1999;
// Moonshot's function-calling API rejects requests while any single tool
// parameters schema exceeds its literal serialized size cap. Community
// measurements bound the cap between ~13.7 KB (accepted) and ~15 KB
// (rejected); 13 KiB leaves margin under the lower bound. See
// https://github.com/morluto/rea/issues/1484 for the measured evidence.
export const ADVERTISED_INPUT_SCHEMA_MAX_BYTES = 13 * 1024;

// ---- Portable regex grammar -------------------------------------------------
//
// pattern := "^" alt "$"   (llama.cpp grammars require both anchors)
// atom    := literal | escape | class | "(?:" alt ")" | "(" alt ")"
// quant   := * + ? {n} {n,} {n,m}  with n, m <= 1000, no leading zeros and no
//            lazy or possessive suffix
// escape  := "\" one of ^$\.*+?()[]{}|  | \t \n \r \f \v | \x[0-7][0-9A-Fa-f]
// class   := "[" "^"? item+ "]"  where "-" is a range only between two
//            endpoints, "-" elsewhere is escaped, and no punctuator repeats.
// Excluded: ".", \d \w \s \b and negations (portable syntax, different
// semantics), look-around, backreferences, named groups, \p, \u, \x{..}, \0,
// octal, inline flags, \A \z \Q..\E, non-ASCII literals.

const ALNUM = /^[A-Za-z0-9]$/u;
const ESCAPABLE_OUTSIDE_CLASS = new Set("^$\\.*+?()[]{}|");
const ESCAPABLE_IN_CLASS = new Set("^$\\.*+?()[]{}|-");
const LITERAL_IN_CLASS = new Set("!#%&,:;<=>@`~'\" _.+*?$");
const LITERAL_OUTSIDE_CLASS = new Set("_ !#%&,:;<=>@`~'\"-/");
const CONTROL_ESCAPES = new Set("tnrfv");
const ASCII_HEX_ESCAPE = /^[0-7][0-9A-Fa-f]$/u;
const REPEAT = /^\{(\d+)(?:,(\d*))?\}/u;

const unescapedFinalDollar = (pattern: string): boolean => {
  if (!pattern.endsWith("$")) return false;
  let backslashes = 0;
  for (let index = pattern.length - 2; pattern[index] === "\\"; index--)
    backslashes++;
  return backslashes % 2 === 0;
};

const escapeViolation = (escaped: string): string => {
  if ("dDwWsS".includes(escaped)) return "shorthand-class";
  if ("bB".includes(escaped)) return "word-boundary";
  if (/^[0-9]$/u.test(escaped)) return "octal-or-backreference";
  if ("uU".includes(escaped)) return "unicode-escape";
  if ("pP".includes(escaped)) return "unicode-property";
  if (escaped === "k") return "named-backreference";
  if (escaped === "x") return "non-ascii-or-braced-hex-escape";
  return `escape:\\${escaped}`;
};

/**
 * Name every construct in `pattern` outside the portable regex grammar. An
 * empty result means it compiles with the same syntax in all seven engine
 * modes the grammar was checked against.
 */
export const portablePatternViolations = (
  pattern: string,
): readonly string[] => {
  const found = new Set<string>();
  if (!pattern.startsWith("^") || !unescapedFinalDollar(pattern))
    found.add("unanchored");
  for (const character of pattern) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code > 0x7e) found.add("non-ascii-literal");
  }
  const at = (index: number): string => pattern[index] ?? "";
  let index = 0;
  const groups = [1];
  let lastAtom = 1;
  while (index < pattern.length) {
    const character = at(index);
    if (character === "\\") {
      lastAtom = 1;
      const escaped = at(index + 1);
      if (escaped === "") {
        found.add("trailing-escape");
        break;
      }
      if (
        ESCAPABLE_OUTSIDE_CLASS.has(escaped) ||
        CONTROL_ESCAPES.has(escaped) ||
        (escaped === "x" &&
          ASCII_HEX_ESCAPE.test(pattern.slice(index + 2, index + 4)))
      ) {
        index += escaped === "x" ? 4 : 2;
        continue;
      }
      found.add(
        escaped === "-"
          ? "escaped-hyphen-outside-class"
          : escapeViolation(escaped),
      );
      index += 2;
      continue;
    }
    if (character === "[") {
      lastAtom = 1;
      let cursor = index + 1;
      if (at(cursor) === "^") cursor++;
      if (at(cursor) === "]") found.add("empty-or-leading-bracket-class");
      let previous: "endpoint" | "range" | "punctuator" | "start" = "start";
      while (cursor < pattern.length && at(cursor) !== "]") {
        const member = at(cursor);
        if (member === "\\") {
          const escaped = at(cursor + 1);
          if (
            ESCAPABLE_IN_CLASS.has(escaped) ||
            CONTROL_ESCAPES.has(escaped) ||
            (escaped === "x" &&
              ASCII_HEX_ESCAPE.test(pattern.slice(cursor + 2, cursor + 4)))
          ) {
            cursor += escaped === "x" ? 4 : 2;
            previous = "endpoint";
            continue;
          }
          found.add(
            escaped === "" ? "trailing-escape" : escapeViolation(escaped),
          );
          cursor += 2;
          previous = "endpoint";
          continue;
        }
        if (member === "-") {
          if (
            previous === "endpoint" &&
            cursor + 1 < pattern.length &&
            at(cursor + 1) !== "]" &&
            at(cursor + 1) !== "-"
          ) {
            cursor++;
            previous = "range";
            continue;
          }
          found.add("unescaped-hyphen-in-class");
          cursor++;
          previous = "punctuator";
          continue;
        }
        if (ALNUM.test(member)) {
          cursor++;
          previous = "endpoint";
          continue;
        }
        if (LITERAL_IN_CLASS.has(member)) {
          if (at(cursor + 1) === member)
            found.add("doubled-punctuator-in-class");
          cursor++;
          previous = "punctuator";
          continue;
        }
        found.add(
          "[({})|/^".includes(member)
            ? `unescaped-syntax-in-class:${member}`
            : "other-class-character",
        );
        cursor++;
        previous = "punctuator";
      }
      if (cursor >= pattern.length) {
        found.add("unterminated-class");
        break;
      }
      index = cursor + 1;
      continue;
    }
    if (character === "(") {
      groups.push(1);
      if (pattern.startsWith("(?:", index)) {
        index += 3;
        continue;
      }
      if (/^\(\?<?[=!]/u.test(pattern.slice(index))) {
        found.add("look-around");
        index += 3;
        continue;
      }
      if (pattern.startsWith("(?<", index) || pattern.startsWith("(?P", index))
        found.add("named-group");
      else if (pattern.startsWith("(?", index))
        found.add("inline-flags-or-other-group");
      index++;
      continue;
    }
    if (character === ")") {
      lastAtom = groups.length > 1 ? groups.pop()! : 1;
      groups[groups.length - 1] = Math.max(
        groups[groups.length - 1]!,
        lastAtom,
      );
      index++;
      continue;
    }
    if ("*+?".includes(character)) {
      if ("?+".includes(at(index + 1)) && at(index + 1) !== "")
        found.add("lazy-or-possessive");
      index++;
      continue;
    }
    if (character === "{") {
      const repeat = REPEAT.exec(pattern.slice(index));
      if (repeat === null) {
        found.add("literal-brace");
        index++;
        continue;
      }
      // Go reads a bound with a leading zero, such as `{01}`, as literal text.
      if (
        [repeat[1], repeat[2]].some(
          (bound) => bound !== undefined && /^0\d/u.test(bound),
        )
      )
        found.add("repeat-leading-zero");
      const lower = Number(repeat[1]);
      const upper =
        repeat[2] === undefined || repeat[2] === "" ? lower : Number(repeat[2]);
      if (Math.max(lower, upper) > 1000) found.add("repeat-above-1000");
      const nested = lastAtom;
      lastAtom *= Math.max(lower, upper);
      if (nested > 1 && lastAtom > 1000) found.add("nested-repeat-above-1000");
      groups[groups.length - 1] = Math.max(
        groups[groups.length - 1]!,
        lastAtom,
      );
      index += repeat[0].length;
      if ("?+".includes(at(index)) && at(index) !== "")
        found.add("lazy-or-possessive");
      continue;
    }
    if (character === ".") found.add("dot");
    else if (
      !"^$|)".includes(character) &&
      !ALNUM.test(character) &&
      !LITERAL_OUTSIDE_CLASS.has(character)
    )
      found.add(`other-character:${character}`);
    if (!"^$|".includes(character)) lastAtom = 1;
    index++;
  }
  return [...found].sort();
};

// ---- Schema walk ------------------------------------------------------------

type SchemaKind = "input" | "output";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Visit every schema position; instance literals stay opaque. */
const visitSchemas = (
  schema: unknown,
  path: string,
  visit: (node: unknown, path: string, keyword: string | undefined) => void,
  keyword?: string,
): void => {
  visit(schema, path, keyword);
  if (!isRecord(schema)) return;
  for (const [key, value] of Object.entries(schema)) {
    if (schemaMaps.has(key) && isRecord(value))
      for (const [name, child] of Object.entries(value))
        visitSchemas(child, `${path}.${key}.${name}`, visit, key);
    else if (schemaArrays.has(key) && Array.isArray(value))
      value.forEach((child, index) =>
        visitSchemas(child, `${path}.${key}[${String(index)}]`, visit, key),
      );
    else if (schemaChildren.has(key)) {
      if (Array.isArray(value))
        value.forEach((child, index) =>
          visitSchemas(child, `${path}.${key}[${String(index)}]`, visit, key),
        );
      else visitSchemas(value, `${path}.${key}`, visit, key);
    }
  }
};

/** Every `pattern` keyword at a schema position, with its path. */
export const advertisedSchemaPatterns = (
  root: unknown,
): readonly { readonly path: string; readonly pattern: string }[] => {
  const patterns: { path: string; pattern: string }[] = [];
  visitSchemas(root, "$", (node, path) => {
    if (isRecord(node) && typeof node.pattern === "string")
      patterns.push({ path, pattern: node.pattern });
  });
  return patterns;
};

const patternViolations = (
  tool: string,
  schema: SchemaKind,
  root: unknown,
): AdvertisedDialectViolation[] =>
  advertisedSchemaPatterns(root).flatMap(({ path, pattern }) =>
    portablePatternViolations(pattern).map((detail) => ({
      tool,
      schema,
      path,
      rule: "pattern" as const,
      detail,
    })),
  );

const nodeViolations = (
  tool: string,
  node: unknown,
  path: string,
  keyword: string | undefined,
): AdvertisedDialectViolation[] => {
  const violations: AdvertisedDialectViolation[] = [];
  const add = (rule: AdvertisedDialectRule, detail?: string) =>
    violations.push({
      tool,
      schema: "input",
      path,
      rule,
      ...(detail === undefined ? {} : { detail }),
    });
  if (!isRecord(node)) {
    // `additionalProperties: false` is the closed-object form every target accepts.
    if (
      typeof node === "boolean" &&
      !(node === false && keyword === "additionalProperties")
    )
      add("boolean-schema");
    return violations;
  }
  for (const key of Object.keys(node))
    if (!ALLOWED_KEYWORDS.has(key)) add("keyword", key);
  const { type } = node;
  if (Array.isArray(type)) add("type", "type-list");
  else if (type === undefined) add("type", "untyped");
  else if (typeof type !== "string" || !PRIMITIVE_TYPES.has(type))
    add("type", `type:${String(type)}`);
  if (type === "array" && node.items === undefined)
    add("array-items", "missing");
  if (node.items !== undefined && type !== "array")
    add("array-items", "beside-non-array-type");
  if (Array.isArray(node.items)) add("array-items", "tuple");
  if (node.enum !== undefined) {
    const values = node.enum;
    if (!Array.isArray(values) || values.length === 0) add("enum", "empty");
    else if (values.some((value) => typeof value !== "string"))
      add("enum", "non-string");
    else if (values.includes("")) add("enum", "empty-string");
    if (type !== "string") add("enum", "not-on-string-type");
  }
  if (node.anyOf !== undefined) {
    const branches = node.anyOf;
    if (path === "$") add("any-of", "root");
    if (!Array.isArray(branches) || branches.length < 2)
      add("any-of", "fewer-than-two-branches");
    else if (
      branches.some((branch) => !isRecord(branch) || branch.type === undefined)
    )
      add("any-of", "untyped-branch");
    if (node.properties !== undefined) add("any-of", "beside-properties");
  }
  if (
    typeof node.description === "string" &&
    node.description.length > DESCRIPTION_LIMIT
  )
    add("description-length");
  for (const bound of ["minLength", "maxLength", "minItems", "maxItems"])
    if (typeof node[bound] === "number" && node[bound] >= BOUND_LIMIT)
      add("bound", bound);
  if (isRecord(node.properties))
    for (const name of Object.keys(node.properties))
      if (!PROPERTY_NAME.test(name)) add("property-name", name);
  return violations;
};

/** Advertised tool fields the portable dialect constrains. */
export interface AdvertisedToolDefinition {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
}

/**
 * Every construct outside the portable dialect in one tool's name,
 * description and input schema: the definition a client forwards to a model.
 */
export const advertisedInputDialectViolations = (
  tool: AdvertisedToolDefinition,
): readonly AdvertisedDialectViolation[] => {
  const { name, inputSchema: input } = tool;
  const violations: AdvertisedDialectViolation[] = [];
  const whole = (schema: "tool" | "input", rule: AdvertisedDialectRule) => {
    violations.push({ tool: name, schema, path: "$", rule });
  };
  if (!TOOL_NAME.test(name)) whole("tool", "tool-name");
  if ((tool.description ?? "").length > TOOL_DESCRIPTION_LIMIT)
    whole("tool", "tool-description-length");
  if (serializedBytes(input) > ADVERTISED_INPUT_SCHEMA_MAX_BYTES)
    whole("input", "input-bytes");
  if (schemaDepth(input) > COMPACT_SCHEMA_MAX_DEPTH)
    whole("input", "input-depth");
  if (
    !isRecord(input) ||
    input.type !== "object" ||
    ["anyOf", "oneOf", "allOf"].some((key) => Object.hasOwn(input, key))
  )
    whole("input", "root-shape");
  visitSchemas(input, "$", (node, path, keyword) =>
    violations.push(...nodeViolations(name, node, path, keyword)),
  );
  violations.push(...patternViolations(name, "input", input));
  return violations;
};

/**
 * Patterns outside the portable grammar in one tool's output schema. No model
 * reads output schemas, but SDK clients compile every one, and a pattern their
 * engine refuses fails the call before it is sent.
 */
export const advertisedOutputPatternViolations = (
  tool: AdvertisedToolDefinition,
): readonly AdvertisedDialectViolation[] =>
  tool.outputSchema === undefined
    ? []
    : patternViolations(tool.name, "output", tool.outputSchema);

/** Stable count key: schema, rule and, when present, the specific construct. */
export const advertisedDialectViolationKey = (
  violation: AdvertisedDialectViolation,
): string =>
  [violation.schema, violation.rule, violation.detail]
    .filter((part) => part !== undefined)
    .join(" ");

/** Occurrences per violation key, in key order. */
export const countAdvertisedDialectViolations = (
  violations: Iterable<AdvertisedDialectViolation>,
): Readonly<Record<string, number>> => {
  const counts = new Map<string, number>();
  for (const violation of violations) {
    const key = advertisedDialectViolationKey(violation);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => (left < right ? -1 : 1)),
  );
};

/**
 * Keys whose observed count exceeds the recorded allowance. A key absent from
 * `allowed` is enforced at zero, so a new construct fails immediately.
 */
export const advertisedDialectRegressions = (
  observed: Readonly<Record<string, number>>,
  allowed: Readonly<Record<string, number>>,
): readonly string[] =>
  Object.entries(observed).flatMap(([key, count]) => {
    const limit = Object.hasOwn(allowed, key) ? allowed[key]! : 0;
    return count > limit ? [`${key}: ${String(count)} > ${String(limit)}`] : [];
  });
