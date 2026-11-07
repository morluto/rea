import { z } from "zod";

import type { JsonValue } from "../jsonValue.js";
import { gunzip, isGzip } from "./gzipDocument.js";

/** A secret's handle: the name of one file in the build host's secrets folder. */
export const buildSecretHandleSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._\-]{0,62}$/u)
  .describe(
    "The handle of a secret: the name of a file the person wrote in REA's build-secrets folder. Lowercase letters, digits, dot, dash and underscore.",
  );

/** The fewest characters a secret holds, so a scan can tell it from ordinary text. */
const MIN_SECRET_CHARACTERS = 8;
/** The most characters one secret holds, as one typed field takes. */
export const MAX_SECRET_CHARACTERS = 1024;
/** How much of a gzip file the scan decompresses to search inside it. */
const MAX_GUNZIPPED_BYTES = 64 * 1024 * 1024;

/** A secret the build host knows: its handle and the value it names. */
export interface KnownSecret {
  readonly handle: string;
  readonly value: string;
}

/** What a result shows in place of a secret's value. */
const secretPlaceholder = (handle: string): string => `<secret:${handle}>`;

/** Why a secret file's text cannot be typed as a secret, or undefined when it can. */
export const secretValueRefusal = (value: string): string | undefined => {
  const characters = [...value].length;
  if (characters < MIN_SECRET_CHARACTERS)
    return `it holds fewer than ${String(MIN_SECRET_CHARACTERS)} characters, too few for REA to tell it from ordinary text when it checks the bundle`;
  if (characters > MAX_SECRET_CHARACTERS)
    return `it holds more than ${String(MAX_SECRET_CHARACTERS)} characters`;
  if (/\p{Cc}/u.test(value))
    return "it holds a control character, such as a line break inside it, which a keyboard does not type";
  return undefined;
};

/** The characters of the base64 encoding of `bytes` that depend on them alone, when they start `offset` bytes into a longer encoding. */
const base64Stable = (bytes: Buffer, offset: number): string => {
  const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString(
    "base64",
  );
  return encoded.slice(
    Math.ceil((8 * offset) / 6),
    Math.floor((8 * (offset + bytes.length)) / 6),
  );
};

/** The value's spellings as text: as it is, escaped in JSON, in hex, in base64 at each alignment and in URL encoding. */
const textSpellings = (value: string): readonly string[] => {
  const bytes = Buffer.from(value, "utf8");
  const hex = bytes.toString("hex");
  const base64 = [0, 1, 2].map((offset) => base64Stable(bytes, offset));
  const url = encodeURIComponent(value);
  return [
    ...new Set([
      value,
      JSON.stringify(value).slice(1, -1),
      hex,
      hex.toUpperCase(),
      ...base64,
      ...base64.map((text) => text.replaceAll("+", "-").replaceAll("/", "_")),
      url,
      url.replaceAll("%20", "+"),
      url.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase()),
    ]),
  ];
};

/** The byte spellings a scan looks for: each text spelling in UTF-8, and the value in UTF-16 of either byte order. */
const byteSpellings = (value: string): readonly Buffer[] => {
  const utf16 = Buffer.from(value, "utf16le");
  return [
    ...textSpellings(value).map((text) => Buffer.from(text, "utf8")),
    utf16,
    Buffer.from(utf16).swap16(),
  ];
};

const holds = (bytes: Uint8Array, spellings: readonly Buffer[]): boolean => {
  const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  return spellings.some((spelling) => haystack.includes(spelling));
};

/** The handles of the secrets `bytes` hold in any spelling, also inside a gzip file. */
export const secretsIn = (
  bytes: Uint8Array,
  secrets: readonly KnownSecret[],
): string[] => {
  if (secrets.length === 0) return [];
  const inner = isGzip(bytes) ? gunzip(bytes, MAX_GUNZIPPED_BYTES) : undefined;
  return secrets.flatMap(({ handle, value }) => {
    const spellings = byteSpellings(value);
    return holds(bytes, spellings) ||
      (inner?.ok === true && holds(inner.value, spellings))
      ? [handle]
      : [];
  });
};

/** Text with each text spelling of each secret, longest first, replaced by its handle's placeholder. */
export const redactSecrets = (
  text: string,
  secrets: readonly KnownSecret[],
): string => {
  const spellings = secrets
    .flatMap(({ handle, value }) =>
      textSpellings(value).map((spelling) => ({ handle, spelling })),
    )
    .sort((left, right) => right.spelling.length - left.spelling.length);
  return spellings.reduce(
    (redacted, { handle, spelling }) =>
      redacted.replaceAll(spelling, secretPlaceholder(handle)),
    text,
  );
};

/** A JSON value with every string in it, member names included, redacted. */
export const redactSecretsInJson = (
  value: JsonValue,
  secrets: readonly KnownSecret[],
): JsonValue => {
  if (secrets.length === 0) return value;
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value))
    return value.map((item) => redactSecretsInJson(item, secrets));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [
      redactSecrets(name, secrets),
      redactSecretsInJson(item, secrets),
    ]),
  );
};
