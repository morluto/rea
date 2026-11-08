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
/** The most characters a setting's secret holds: a withheld file's bytes in base64. */
export const MAX_SETTING_CHARACTERS = 64 * 1024;
/** How much of a gzip file the scan decompresses to search inside it. */
export const MAX_GUNZIPPED_BYTES = 64 * 1024 * 1024;

/** A secret the build host knows: its handle and the value it names. */
export interface KnownSecret {
  readonly handle: string;
  readonly value: string;
}

/** What a result shows in place of a secret's value. */
const secretPlaceholder = (handle: string): string => `<secret:${handle}>`;

/** Whether a scan looks for a value: one too short to tell from ordinary text, as a tiny withheld file's, it never looks for. */
export const isScannableSecret = (value: string): boolean =>
  [...value].length >= MIN_SECRET_CHARACTERS;

/** Why a secret file's text cannot be used as a secret of `minCharacters` to `maxCharacters`, or undefined when it can. */
export const secretValueRefusal = (
  value: string,
  maxCharacters = MAX_SECRET_CHARACTERS,
  minCharacters = MIN_SECRET_CHARACTERS,
): string | undefined => {
  const characters = [...value].length;
  if (characters < minCharacters)
    return `it holds fewer than ${String(minCharacters)} characters, too few for REA to tell it from ordinary text when it checks the bundle`;
  if (characters > maxCharacters)
    return `it holds more than ${String(maxCharacters)} characters`;
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

const jsonEscaped = (text: string) => JSON.stringify(text).slice(1, -1);
const xmlEscaped = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");

/** The value's spellings as text: as it is, escaped in XML and in JSON once or twice, in hex, in base64 at each alignment and in URL and form encoding. */
const textSpellings = (value: string): readonly string[] => {
  const bytes = Buffer.from(value, "utf8");
  const hex = bytes.toString("hex");
  const base64 = [0, 1, 2].map((offset) => base64Stable(bytes, offset));
  const url = encodeURIComponent(value);
  const form = new URLSearchParams([["value", value]])
    .toString()
    .slice("value=".length);
  const xml = [
    value,
    xmlEscaped(value),
    xmlEscaped(value).replaceAll('"', "&quot;"),
  ];
  return [
    ...new Set([
      ...xml,
      ...xml.map(jsonEscaped),
      ...xml.map((text) => jsonEscaped(jsonEscaped(text))),
      hex,
      hex.toUpperCase(),
      ...base64,
      ...base64.map((text) => text.replaceAll("+", "-").replaceAll("/", "_")),
      url,
      url.replaceAll("%20", "+"),
      url.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase()),
      form,
      form.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase()),
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

/** What a scan reads inside a gzip file: its document, or why it has none; undefined for bytes that are not gzip. */
export type GzipInside = ReturnType<typeof gunzip> | undefined;

/** A gzip file decompressed once, as far as a scan reads, for each check of it to share. */
export const gzipInside = (bytes: Uint8Array): GzipInside =>
  isGzip(bytes) ? gunzip(bytes, MAX_GUNZIPPED_BYTES) : undefined;

/** The handles of the secrets `bytes` hold in any spelling, also inside a gzip file; `inner`, when given, is `gzipInside(bytes)`. */
export const secretsIn = (
  bytes: Uint8Array,
  secrets: readonly KnownSecret[],
  inner?: GzipInside,
): string[] => {
  const scanned = secrets.filter(({ value }) => isScannableSecret(value));
  if (scanned.length === 0) return [];
  const inside = inner ?? gzipInside(bytes);
  return scanned.flatMap(({ handle, value }) => {
    const spellings = byteSpellings(value);
    return holds(bytes, spellings) ||
      (inside?.ok === true && holds(inside.value, spellings))
      ? [handle]
      : [];
  });
};

/** Whether bytes are a gzip file that expands past what a scan decompresses, so no scan can tell what it holds inside. */
export const isUncheckedGzip = (
  bytes: Uint8Array,
  inner: GzipInside = gzipInside(bytes),
): boolean => inner?.ok === false && inner.error === "too_large";

/** Replace complete spellings of explicitly known secrets, longest first. */
export const redactSecrets = (
  text: string,
  secrets: readonly KnownSecret[],
): string => {
  const spellings = secrets
    .filter(({ value }) => isScannableSecret(value))
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
  if (!secrets.some(({ value: secret }) => isScannableSecret(secret)))
    return value;
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
