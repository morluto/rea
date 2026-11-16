// Counts hand-written allowance arithmetic that `Budget` (src/domain/budget)
// owns. Two shapes are counted:
//
// 1. A field named for an allowance (`…remaining…`, `…retained…`, `…used…`)
//    adjusted with `+=` or `-=`.
// 2. Inside a hand-written `…Budget` class, any field that is both adjusted
//    by hand (`+=`, `-=`, `++`, `--`) and compared with `<` or `>`: that is a
//    limit check, whatever the field is called (`#bytes`, `#visits`).
//
// Write cursors (`#arenaWriteOffset`) and observation tallies are not
// allowances; outside a `…Budget` class they are not counted unless named as
// one.
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

/** @param {string} content comment-stripped source */
export const budgetArithmeticCount = (content) => {
  let count = content.match(namedAllowance)?.length ?? 0;
  for (const [, body] of content.matchAll(budgetClass)) {
    for (const match of body.matchAll(adjusted)) {
      // Already counted as a named allowance.
      if (new RegExp(`^${namedAllowance.source}$`, "u").test(match[0]))
        continue;
      if (comparedIn(body, match[1] ?? match[2])) count += 1;
    }
  }
  return count;
};
