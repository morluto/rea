// Counts hand-written allowance arithmetic that `Budget` (src/domain/budget)
// owns. Two shapes are counted:
//
// 1. A field named for an allowance (`…remaining…`, `…retained…`, `…used…`)
//    adjusted with `+=` or `-=`.
// 2. Inside a hand-written `…Budget` class, any field that is both adjusted
//    by hand (`+=`, `-=`, `++`, `--`) and compared with `<` or `>`: that is a
//    limit check, whatever the field is called (`#bytes`, `#visits`).
//
// 3. Anywhere else, a field adjusted by hand and compared with `<` or `>`
//    (or `<=`/`>=`) against a value named as a limit (`…max…`, `…limit…`,
//    `…allowance…`, `…budget…`, `…capacity…`): a hand-written allowance.
//
// Write cursors (`#arenaWriteOffset`) and observation tallies that are never
// compared with a limit are not allowances and are not counted. A cursor or
// tally that is compared with a limit without being one (a scan position, an
// observed total, a ring buffer's retained length) is exempt when its field
// declaration carries `// not-an-allowance: <reason>` (#11408). The exemption
// belongs to that field of that top-level class only.

import { markedLineNumbers } from "./reason-marker.mjs";

const NOT_AN_ALLOWANCE = ["not-an-allowance"];

// A class member declaration at member depth (two-space indent, as formatted):
// `#field = 0;`, `private readonly field: number = 0;`. Deeper lines, such as
// object literal properties, are not class fields.
const memberDeclaration =
  /^ {2}(?:(?:private|protected|public|readonly|static|declare)\s+)*(#?\w+)\s*[?!]?\s*[:=]/u;
const namedAllowance =
  /this\.#?\w*(?:[Rr]emaining|[Rr]etained|[Uu]sed)\w*\s*[-+]=/gu;

const adjusted = /(?:\+\+|--)this\.(#?\w+)|this\.(#?\w+)\s*(?:[-+]=|\+\+|--)/gu;

const escape = (name) => name.replaceAll("$", "\\$");

// `<` or `>` near the field on one line, excluding `=>` and shifts.
const comparedIn = (body, name) => {
  const field = `this\\.${escape(name)}\\b`;
  const comparison = "(?<![=<>])[<>](?![<>])";
  return new RegExp(
    `${field}[^;\\n]*${comparison}|${comparison}[^;\\n]*${field}`,
    "u",
  ).test(body);
};

// Limit names in any case: `maxBytes`, `MAX_BYTES`, `FACT_BUDGET`, `capacity`.
const limitName =
  "\\b\\w*(?:[Mm][Aa][Xx]|[Ll][Ii][Mm][Ii][Tt]|[Aa][Ll][Ll][Oo][Ww][Aa][Nn][Cc][Ee]|[Bb][Uu][Dd][Gg][Ee][Tt]|[Cc][Aa][Pp][Aa][Cc][Ii][Tt][Yy])\\w*";

// `<`, `>`, `<=` or `>=` between the field and a limit-named value, one line.
const comparedWithLimit = (scope, name) => {
  const field = `this\\.${escape(name)}\\b`;
  const comparison = "(?<![=<>])[<>]=?(?![<>])";
  return new RegExp(
    `${field}[^;\\n]*${comparison}[^;\\n]*${limitName}|${limitName}[^;\\n]*${comparison}[^;\\n]*${field}`,
    "u",
  ).test(scope);
};

const isNamedAllowance = (text) =>
  new RegExp(`^${namedAllowance.source}$`, "u").test(text);

// Top-level classes (declaration and closing brace at column 0). A field
// belongs to its class, so each class is its own scope; code outside any
// class is one more scope.
const topLevelClass =
  /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)[^\n]*\{\n([\s\S]*?)^\}/gmu;

/** Distinct limit-compared fields adjusted by hand within one scope. */
const limitedFields = (scope, exempt) => {
  const limited = new Set();
  for (const match of scope.matchAll(adjusted)) {
    const name = match[1] ?? match[2];
    if (isNamedAllowance(match[0]) || limited.has(name) || exempt.has(name))
      continue;
    if (comparedWithLimit(scope, name)) limited.add(name);
  }
  return limited.size;
};

const newlines = (text) => text.split("\n").length - 1;

/** Per top-level class, the fields whose declaration carries a marker. */
const exemptClassFields = (raw) => {
  const marked = markedLineNumbers(raw, NOT_AN_ALLOWANCE);
  const lines = raw.split("\n");
  const exempt = new Map();
  for (const match of raw.matchAll(topLevelClass)) {
    const first = newlines(raw.slice(0, match.index));
    const last = first + newlines(match[0]);
    const fields = new Set();
    for (let line = first + 1; line < last; line += 1) {
      const name = marked.has(line)
        ? memberDeclaration.exec(lines[line])?.[1]
        : undefined;
      if (name !== undefined) fields.add(name);
    }
    if (fields.size > 0) exempt.set(match[1], fields);
  }
  return exempt;
};

const fieldOf = (text) => /this\.(#?\w+)/u.exec(text)?.[1];

/** Named-allowance arithmetic in one scope, skipping its exempt fields. */
const namedAllowances = (scope, exempt) =>
  [...scope.matchAll(namedAllowance)].filter(
    (match) => !exempt.has(fieldOf(match[0])),
  ).length;

const NONE = new Set();

/**
 * @param {string} content source with comments blanked (`blankComments`)
 * @param {{ readonly source: string } | undefined} file the raw source, read
 *   for not-an-allowance markers
 */
export const budgetArithmeticCount = (content, file) => {
  const exempt =
    file === undefined ? new Map() : exemptClassFields(file.source);
  let count = 0;
  let outside = content;
  for (const [whole, name, body] of content.matchAll(topLevelClass)) {
    outside = outside.replace(whole, "");
    const fields = exempt.get(name) ?? NONE;
    count += namedAllowances(body, fields);
    if (name.endsWith("Budget")) {
      for (const match of body.matchAll(adjusted)) {
        const field = match[1] ?? match[2];
        // Named allowances are counted above.
        if (isNamedAllowance(match[0]) || fields.has(field)) continue;
        if (comparedIn(body, field)) count += 1;
      }
    } else count += limitedFields(body, fields);
  }
  // Markers exempt class fields only.
  return count + namedAllowances(outside, NONE) + limitedFields(outside, NONE);
};
