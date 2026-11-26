// Counts completed results reclassified by a hand-read abort signal:
// `<receiver>.ok && isAborted(…)` or `<receiver>.ok && …signal.aborted`.
// The receiver chain must start the check, so a negated `!outcome.ok && …`,
// which attaches a secondary cancellation to a failed primary, is not
// counted. Receivers may use member, optional, private, element and call
// segments, or start with one parenthesized expression, and each part may
// carry a TypeScript non-null assertion (`result!.ok`). Parentheses may nest
// one level, as in `(await settle()).ok`; element brackets cannot nest.
const parenthesized = String.raw`\((?:[^()]|\([^()]*\))*\)`;
const segment = String.raw`(?:(?:\??\.#?[A-Za-z_$][\w$]*|(?:\?\.)?\[[^[\]]*\]|(?:\?\.)?${parenthesized})!?)`;
const completedAbortReclassification = new RegExp(
  String.raw`(?<![\w$#.?\])]|!\s*)(?:[A-Za-z_$][\w$]*|${parenthesized})!?${segment}*\??\.ok\s*&&\s*(?:isAborted\(|[\w.?]*signal\??\.aborted)`,
  "gu",
);

/** @param {string} content */
export const completedAbortReclassificationCount = (content) =>
  content.match(completedAbortReclassification)?.length ?? 0;
