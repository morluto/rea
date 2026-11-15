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
// compared with a limit are not allowances and are not counted.
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
const limitedFields = (scope) => {
  const limited = new Set();
  for (const match of scope.matchAll(adjusted)) {
    const name = match[1] ?? match[2];
    if (isNamedAllowance(match[0]) || limited.has(name)) continue;
    if (comparedWithLimit(scope, name)) limited.add(name);
  }
  return limited.size;
};

/** @param {string} content comment-stripped source */
export const budgetArithmeticCount = (content) => {
  let count = content.match(namedAllowance)?.length ?? 0;
  let outside = content;
  for (const [whole, name, body] of content.matchAll(topLevelClass)) {
    outside = outside.replace(whole, "");
    if (name.endsWith("Budget")) {
      for (const match of body.matchAll(adjusted)) {
        // Already counted as a named allowance.
        if (isNamedAllowance(match[0])) continue;
        if (comparedIn(body, match[1] ?? match[2])) count += 1;
      }
    } else count += limitedFields(body);
  }
  return count + limitedFields(outside);
};
