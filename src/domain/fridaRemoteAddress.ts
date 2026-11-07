/**
 * Characters a Frida host address can never contain: URL delimiters that would
 * introduce credentials, a path, a query or a fragment, plus whitespace and
 * C0/DEL controls.
 *
 * Advertised as a schema `pattern` so an SDK-projected input schema rejects the
 * same character set as canonical validation. A `refine` predicate does not
 * project, so without this the advertised schema accepted values the handler
 * rejects. The remaining checks below are URL-level semantics that a portable
 * pattern cannot express, so they stay in the predicate.
 *
 * The class spells controls and the solidus with `\x00` hex escapes. These
 * accept exactly the strings the previous inline class accepted; the hex form
 * matches the convention `nulFreeStringSchema` uses for patterns that reach
 * strict schema consumers. A bare `/` would be a `v`-mode reserved punctuator,
 * so a consumer compiling the advertised pattern with `v` would throw instead
 * of validating the address.
 */
export const FRIDA_REMOTE_ADDRESS_CHARSET = /^[^?@#\x2f\s\x00-\x1f\x7f]+$/u;

/** Accept a Frida host address, optionally with a TCP port, without URL credentials or paths. */
export const isValidFridaRemoteAddress = (address: string): boolean => {
  if (address.length === 0 || address.length > 2048) return false;
  if (!FRIDA_REMOTE_ADDRESS_CHARSET.test(address)) return false;
  if (address.endsWith(":")) return false;
  try {
    const parsed = new URL(`tcp://${address}`);
    const port = parsed.port === "" ? undefined : Number(parsed.port);
    return (
      parsed.hostname.length > 0 &&
      (port === undefined || (port > 0 && port <= 65_535)) &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      (parsed.pathname === "" || parsed.pathname === "/") &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0
    );
  } catch {
    return false;
  }
};
