/** Encode one RFC 6901 reference token. */
export const escapeJsonPointerToken = (token: string): string =>
  token.replaceAll("~", "~0").replaceAll("/", "~1");

/** Decode a reference token without validating the enclosing pointer. */
export const unescapeJsonPointerToken = (token: string): string =>
  token.replaceAll("~1", "/").replaceAll("~0", "~");

/** Check the RFC 6901 string form before interpreting any reference token. */
export const jsonPointerSyntaxProblem = (
  pointer: string,
): "missing-slash" | "invalid-escape" | null => {
  if (pointer === "") return null;
  if (!pointer.startsWith("/")) return "missing-slash";
  return /~(?![01])/u.test(pointer) ? "invalid-escape" : null;
};

/** Split an already-admitted JSON pointer into decoded reference tokens. */
export const jsonPointerTokens = (pointer: string): string[] =>
  pointer === ""
    ? []
    : pointer.slice(1).split("/").map(unescapeJsonPointerToken);
