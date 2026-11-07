import type { JsonValue } from "../jsonValue.js";
import {
  derKeySpans,
  holdsDerPrivateKey,
  redactDerKeys,
} from "./derPrivateKeys.js";
import { gunzip, isGzip } from "./gzipDocument.js";

/** A kind of credential found by its shape, whatever its value, and the pattern that finds it. */
interface CredentialPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

/** Credentials no handle names, by the shape their issuers give them; a private key as PEM here, and as DER, as apps keep generated keys, by `derKeySpans`. */
const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  {
    name: "private-key",
    pattern:
      /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----(?:[\s\S]*?-----END (?:[A-Z]+ )*PRIVATE KEY-----|[\s\S]*)/gu,
  },
  {
    name: "url-credentials",
    pattern:
      /(?<=[a-zA-Z][\w+.-]*:\/\/)(?:[^/@\s:"'<>]+:[^/@\s"'<>]+|[^/@\s:"'<>]{16,})(?=@)/gu,
  },
  { name: "api-key", pattern: /\bsk[-_](?=[\w-]*\d)[\w-]{20,}/gu },
  {
    name: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{22,})/gu,
  },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu },
  { name: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/gu },
  { name: "google-api-key", pattern: /\bAIza[\w-]{35}/gu },
  { name: "hugging-face-token", pattern: /\bhf_[A-Za-z0-9]{30,}/gu },
  { name: "jwt", pattern: /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/gu },
];

/** How much of a gzip file the scan decompresses to search inside it. */
const MAX_GUNZIPPED_BYTES = 64 * 1024 * 1024;

/** The kinds of credential a text holds, each once, in pattern order. */
export const credentialsIn = (text: string): string[] => [
  ...new Set([
    ...(derKeySpans(text).length > 0 ? ["private-key"] : []),
    ...CREDENTIAL_PATTERNS.filter(({ pattern }) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    }).map(({ name }) => name),
  ]),
];

/** The texts a file's bytes may spell: Latin-1, so any byte matches, and UTF-16 of either byte order. */
const textsOf = (bytes: Buffer): string[] => [
  bytes.toString("latin1"),
  bytes.toString("utf16le"),
  bytes.subarray(1).toString("utf16le"),
];

/** The kinds of credential a file holds: in its bytes as text of any encoding, as raw DER, and inside a gzip file too. */
export const credentialsInBytes = (bytes: Uint8Array): string[] => {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  const inner = isGzip(bytes) ? gunzip(bytes, MAX_GUNZIPPED_BYTES) : undefined;
  const files = inner?.ok === true ? [buffer, inner.value] : [buffer];
  const found = new Set(
    files.flatMap((file) => [
      ...(holdsDerPrivateKey(file) ? ["private-key"] : []),
      ...textsOf(file).flatMap(credentialsIn),
    ]),
  );
  return ["private-key", ...CREDENTIAL_PATTERNS.map(({ name }) => name)].filter(
    (name, index, names) => found.has(name) && names.indexOf(name) === index,
  );
};

/** Text with each credential found by its shape replaced by `<credential:kind>`. */
export const redactCredentials = (text: string): string =>
  CREDENTIAL_PATTERNS.reduce(
    (redacted, { name, pattern }) =>
      redacted.replace(pattern, `<credential:${name}>`),
    redactDerKeys(text),
  );

/** A JSON value with every string in it, member names included, rid of credentials found by their shape. */
export const redactCredentialsInJson = (value: JsonValue): JsonValue => {
  if (typeof value === "string") return redactCredentials(value);
  if (Array.isArray(value)) return value.map(redactCredentialsInJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [
      redactCredentials(name),
      redactCredentialsInJson(item),
    ]),
  );
};
