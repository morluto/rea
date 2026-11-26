// A first-match lookup by key field: `find`/`findLast`, or `filter(...)`
// followed by an optional `.map(...)` and `[0]`, whose arrow predicate compares
// the parameter's key field (`x.name === …`) or a destructured key
// (`({ offset, name }) => name === …`). Recognized by shape, whatever the
// table variable is called. Syntactic: a predicate that compares through a
// helper, or a renamed destructured key, is not recognized.
const KEY = String.raw`(?:name|type|cmd|command|tag)`;
// `x`, `(x)` or `(x: Type)`; group 1 names the parameter.
const PLAIN = String.raw`\(?\s*(\w+)\s*(?::[^)=]*)?\)?\s*=>\s*\1\.${KEY}\s*===`;
// `({ ..., key, ... })`, optionally typed; group 1 names the key. A renamed
// key (`{ name: alias }`) binds another identifier and is skipped.
const DESTRUCTURED = String.raw`\(\s*\{[^}]*?\b(${KEY})\b(?!\s*:)[^}]*\}\s*(?::[^)]*)?\)\s*=>\s*\1\s*===`;
const FIND = String.raw`\.find(?:Last)?\(\s*`;
const FILTER = String.raw`\.filter\(\s*`;

const FIND_PATTERNS = [
  new RegExp(FIND + PLAIN, "gu"),
  new RegExp(FIND + DESTRUCTURED, "gu"),
];
const FILTER_PATTERNS = [
  new RegExp(FILTER + PLAIN, "gu"),
  new RegExp(FILTER + DESTRUCTURED, "gu"),
];

/** Index of the quote that closes the literal opening at `start`, or -1. */
const literalEnd = (content, start) => {
  const quote = content[start];
  for (let index = start + 1; index < content.length; index += 1) {
    if (content[index] === "\\") index += 1;
    else if (content[index] === quote) return index;
  }
  return -1;
};

/**
 * Index just past the parenthesis that closes the one at `open`, or -1.
 * Parentheses inside string and template literals do not count.
 */
export const closingParen = (content, open) => {
  let depth = 0;
  for (let index = open; index < content.length; index += 1) {
    const character = content[index];
    if (character === '"' || character === "'" || character === "`") {
      index = literalEnd(content, index);
      if (index < 0) return -1;
    } else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
};

const skipSpace = (content, index) => {
  while (index < content.length && /\s/u.test(content[index])) index += 1;
  return index;
};

// Whether the `filter(` call opening at `open` is closed, optionally followed
// by one `.map(...)`, and then indexed with `[0]`. Matching the parentheses
// keeps a `[0]` inside the predicate or the map callback from counting.
const indexesFirstResult = (content, open) => {
  let end = closingParen(content, open);
  if (end < 0) return false;
  end = skipSpace(content, end);
  if (content.startsWith(".map(", end)) {
    end = closingParen(content, end + ".map".length);
    if (end < 0) return false;
    end = skipSpace(content, end);
  }
  return content.startsWith("[0]", end);
};

const count = (content, pattern, accept) =>
  [...content.matchAll(pattern)].filter(accept).length;

/** Number of first-match lookups by key field in `content`. */
export const countKeyedFirstMatches = (content) =>
  FIND_PATTERNS.reduce(
    (total, pattern) => total + count(content, pattern, () => true),
    0,
  ) +
  FILTER_PATTERNS.reduce(
    (total, pattern) =>
      total +
      count(content, pattern, (match) =>
        indexesFirstResult(content, match.index + ".filter".length),
      ),
    0,
  );
