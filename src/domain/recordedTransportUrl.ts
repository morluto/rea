/** Raw coordinates are independent of WHATWG's normalized origin and pathname. */
export interface RecordedTransportUrl {
  readonly origin: string | null;
  readonly path: string | null;
  readonly credentials:
    | { readonly start: number; readonly end: number }
    | "ambiguous"
    | null;
}

/**
 * Interpret transport URL syntax once for credential exclusion and recorded-path
 * projection. Never use URL.pathname: it removes observed dot segments.
 * Noncanonical spellings may have parsed credentials but no safe raw span.
 */
export const parseRecordedTransportUrl = (
  value: string,
): RecordedTransportUrl => {
  const prefix = /^[\x00-\x20]*(?:([A-Za-z][A-Za-z0-9+.-]*):)?\/\//u.exec(
    value,
  );
  const absolute = URL.parse(value);
  // Resolve references only to recognize credentials (including WHATWG's
  // backslash/control-character spellings), never to supply a projected origin.
  const parsed = absolute ?? URL.parse(value, "https://rea.invalid");
  const hasCredentials =
    parsed !== null && (parsed.username !== "" || parsed.password !== "");
  const origin =
    absolute !== null && absolute.origin !== "null" ? absolute.origin : null;
  if (prefix === null)
    return {
      origin,
      path: null,
      credentials: hasCredentials ? "ambiguous" : null,
    };

  const authorityStart = prefix[0].length;
  const protocol =
    parsed?.protocol ?? `${prefix[1]?.toLowerCase() ?? "https"}:`;
  const special = ["ftp:", "file:", "http:", "https:", "ws:", "wss:"].includes(
    protocol,
  );
  let authorityEnd = authorityStart;
  while (
    authorityEnd < value.length &&
    !"/?#".includes(value[authorityEnd]!) &&
    !(special && value[authorityEnd] === "\\")
  )
    authorityEnd += 1;
  const authority = value.slice(authorityStart, authorityEnd);
  const stableAuthority = authority.length > 0 && !/[\t\n\r]/u.test(authority);
  const at = authority.lastIndexOf("@");
  const credentials =
    !stableAuthority && hasCredentials
      ? "ambiguous"
      : at >= 0
        ? { start: authorityStart, end: authorityStart + at + 1 }
        : hasCredentials
          ? "ambiguous"
          : null;
  // Only an explicit, unpadded scheme://authority has a recorded absolute path.
  // Backslashes are authority/path separators for special schemes in WHATWG.
  if (
    origin === null ||
    !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value) ||
    !stableAuthority ||
    (special && value[authorityEnd] === "\\")
  )
    return { origin, path: null, credentials };
  if (value[authorityEnd] !== "/") return { origin, path: "/", credentials };
  let pathEnd = authorityEnd;
  while (pathEnd < value.length && !"?#".includes(value[pathEnd]!))
    pathEnd += 1;
  return { origin, path: value.slice(authorityEnd, pathEnd), credentials };
};
