// Counts hand-read abort checks on a completed Result (`result.ok && ...`),
// excluding negated checks (`!outcome.ok && signal?.aborted`) that attach a
// secondary cancellation to a failed primary. Uses shared tokens so indexed,
// parenthesized, and call-chained receivers (such as `!results[0].ok` or
// `!this.readResult().outcome.ok`) are resolved accurately.
import { tokenize } from "./source-tokens.mjs";

const punct = (token) => (token?.kind === "punct" ? token.text : undefined);

const closers = { ")": "(", "]": "[", "}": "{" };

/** Index of the bracket that opens the group closed at `close`. */
const matchingOpen = (tokens, close) => {
  let depth = 0;
  for (let at = close; at >= 0; at -= 1) {
    const text = punct(tokens[at]);
    if (text !== undefined && text in closers) depth += 1;
    else if (text === "(" || text === "[" || text === "{") {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return undefined;
};

/** Ends a callee or object, so a following `(` or `[` is a call or element read. */
const endsOperand = (token) =>
  (token?.kind === "id" && token.keyword !== true) ||
  punct(token) === ")" ||
  punct(token) === "]" ||
  token?.nonNullAssertion === true;

/** First token of the member, call, and element chain ending at `end`. */
const operandStart = (tokens, end) => {
  let at = end;
  for (;;) {
    if (tokens[at]?.nonNullAssertion === true && at >= 1) {
      at -= 1;
      continue;
    }
    const text = punct(tokens[at]);
    if (text === ")" || text === "]") {
      const open = matchingOpen(tokens, at);
      if (open === undefined) return at;
      at = open;
    }
    const previous = tokens[at - 1];
    if ((punct(previous) === "." || punct(previous) === "?.") && at >= 2)
      at -= 2;
    else if (
      (punct(tokens[at]) === "(" || punct(tokens[at]) === "[") &&
      endsOperand(previous)
    )
      at -= 1;
    else return at;
  }
};

const isUnaryBang = (token) =>
  token?.kind === "punct" &&
  token.text === "!" &&
  token.nonNullAssertion !== true;

const isHandReadAbortCheck = (tokens, start) => {
  if (tokens[start]?.kind === "id" && tokens[start].text === "isAborted")
    return punct(tokens[start + 1]) === "(";
  for (let at = start; tokens[at]?.kind === "id";) {
    const access = punct(tokens[at + 1]);
    if (access !== "." && access !== "?.") return false;
    if (
      tokens[at].text.endsWith("signal") &&
      tokens[at + 2]?.kind === "id" &&
      tokens[at + 2].text === "aborted"
    )
      return true;
    at += 2;
  }
  return false;
};

/** @param {string} content */
export const completedAbortReclassificationCount = (content) => {
  const { tokens } = tokenize(content);
  let count = 0;
  for (let at = 1; at < tokens.length - 2; at += 1) {
    if (tokens[at]?.kind !== "id" || tokens[at].text !== "ok") continue;
    const access = punct(tokens[at - 1]);
    if (access !== "." && access !== "?.") continue;
    if (punct(tokens[at + 1]) !== "&&") continue;
    if (!isHandReadAbortCheck(tokens, at + 2)) continue;
    const start = operandStart(tokens, at);
    let bangs = 0;
    while (isUnaryBang(tokens[start - 1 - bangs])) bangs += 1;
    if (bangs % 2 === 1) continue;
    count += 1;
  }
  return count;
};
