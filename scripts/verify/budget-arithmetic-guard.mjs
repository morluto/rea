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

const budgetClass =
  /^(?:export\s+)?class\s+\w*Budget\b[^\n]*\{\n([\s\S]*?)^\}/gmu;

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

const limitName =
  "\\b\\w*(?:[Mm]ax|[Ll]imit|MAX_|LIMIT|[Aa]llowance|[Bb]udget|[Cc]apacity)\\w*";

// `<`, `>`, `<=` or `>=` between the field and a limit-named value, one line.
const comparedWithLimit = (content, name) => {
  const field = `this\\.${escape(name)}\\b`;
  const comparison = "(?<![=<>])[<>]=?(?![<>])";
  return new RegExp(
    `${field}[^;\\n]*${comparison}[^;\\n]*${limitName}|${limitName}[^;\\n]*${comparison}[^;\\n]*${field}`,
    "u",
  ).test(content);
};

const isNamedAllowance = (text) =>
  new RegExp(`^${namedAllowance.source}$`, "u").test(text);

/** @param {string} content comment-stripped source */
export const budgetArithmeticCount = (content) => {
  let count = content.match(namedAllowance)?.length ?? 0;
  const inBudgetClass = new Set();
  for (const [, body] of content.matchAll(budgetClass)) {
    for (const match of body.matchAll(adjusted)) {
      const name = match[1] ?? match[2];
      inBudgetClass.add(name);
      // Already counted as a named allowance.
      if (isNamedAllowance(match[0])) continue;
      if (comparedIn(body, name)) count += 1;
    }
  }
  const limited = new Set();
  for (const match of content.matchAll(adjusted)) {
    const name = match[1] ?? match[2];
    if (isNamedAllowance(match[0]) || inBudgetClass.has(name)) continue;
    if (limited.has(name)) continue;
    if (comparedWithLimit(content, name)) limited.add(name);
  }
  return count + limited.size;
};
