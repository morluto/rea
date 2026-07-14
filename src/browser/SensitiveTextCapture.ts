const SECRET_ASSIGNMENT =
  /\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookie|session)\b\s*[:=]\s*(?:Bearer\s+[A-Za-z0-9._~+/=-]+|"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;

/** Redact credential-shaped substrings before approved console text is retained. */
export const redactSensitiveText = (value: string): string =>
  value
    .replace(SECRET_ASSIGNMENT, (_match, name: string) => `${name}=[REDACTED]`)
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(JWT, "[REDACTED_JWT]");

/** Return a UTF-8-bounded prefix without splitting a code point. */
export const boundedSensitiveText = (
  value: string,
  maximumBytes: number,
): {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
} => {
  const redacted = redactSensitiveText(value);
  const total = Buffer.byteLength(redacted);
  if (total <= maximumBytes)
    return { text: redacted, bytes: total, truncated: false };
  let text = "";
  let bytes = 0;
  for (const character of redacted) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maximumBytes) break;
    text += character;
    bytes += size;
  }
  return { text, bytes, truncated: true };
};
