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
// The rest of the filter call, an optional `.map(...)`, then `[0]`.
const FIRST = String.raw`[^;]*?\)\s*(?:\.map\([^;]*?\)\s*)?\[0\]`;

const PATTERNS = [
  new RegExp(FIND + PLAIN, "gu"),
  new RegExp(FIND + DESTRUCTURED, "gu"),
  new RegExp(FILTER + PLAIN + FIRST, "gu"),
  new RegExp(FILTER + DESTRUCTURED + FIRST, "gu"),
];

/** Number of first-match lookups by key field in `content`. */
export const countKeyedFirstMatches = (content) =>
  PATTERNS.reduce(
    (count, pattern) => count + (content.match(pattern)?.length ?? 0),
    0,
  );
