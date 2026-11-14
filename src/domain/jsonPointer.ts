/** Encode one RFC 6901 reference token. */
export const escapeJsonPointerToken = (token: string): string =>
  token.replaceAll("~", "~0").replaceAll("/", "~1");

/** Decode a reference token without validating the enclosing pointer. */
export const unescapeJsonPointerToken = (token: string): string =>
  token.replaceAll("~1", "/").replaceAll("~0", "~");

/** Split an already-admitted JSON pointer into decoded reference tokens. */
export const jsonPointerTokens = (pointer: string): string[] =>
  pointer === ""
    ? []
    : pointer.slice(1).split("/").map(unescapeJsonPointerToken);
