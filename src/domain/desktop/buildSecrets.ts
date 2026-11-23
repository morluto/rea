import { z } from "zod";

import type { JsonValue } from "../jsonValue.js";
import { gunzip, isGzip } from "./gzipDocument.js";
import { decodeStateText, jsonStringChunks } from "./stateFormats.js";
import {
  explicitTextSpellings,
  explicitUtf16Spellings,
  lowercasePercentEscapes,
} from "../explicitSensitiveValues.js";

const UTF16LE_FATAL = new TextDecoder("utf-16le", { fatal: true });
const UTF16BE_FATAL = new TextDecoder("utf-16be", { fatal: true });
const UTF16LE_ESCAPE_MARKER = Buffer.from([0x5c, 0, 0x75, 0]);
const UTF16BE_ESCAPE_MARKER = Buffer.from([0, 0x5c, 0, 0x75]);

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

const jsonEscaped = (text: string): string =>
  explicitTextSpellings(text, ["json-escaped"])[0] ?? text;
const xmlEscaped = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");

/** The value's spellings as text: as it is, escaped in XML and in JSON once or twice, in hex, in base64 at each alignment and in URL and form encoding with either escape case. */
const textSpellings = (value: string): readonly string[] => {
  const escapedXml = xmlEscaped(value);
  const xml = [
    value,
    ...[escapedXml, escapedXml.replaceAll(">", "&gt;")].flatMap((text) => [
      text,
      text.replaceAll('"', "&quot;"),
    ]),
  ];
  const percent = explicitTextSpellings(value, [
    "uri-component",
    "uri-plus-space",
    "form",
  ]);
  return [
    ...new Set([
      ...xml,
      ...xml.map(jsonEscaped),
      ...xml.map((text) => jsonEscaped(jsonEscaped(text))),
      ...explicitTextSpellings(value, ["hex", "base64"]),
      ...percent,
      ...percent.map(lowercasePercentEscapes),
    ]),
  ];
};

/** The byte spellings a scan looks for: each text spelling in UTF-8, and the value in UTF-16 of either byte order. */
const byteSpellings = (value: string): readonly Buffer[] => [
  ...textSpellings(value).map((text) => Buffer.from(text, "utf8")),
  ...explicitUtf16Spellings(value),
];

const holds = (bytes: Uint8Array, spellings: readonly Buffer[]): boolean => {
  const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  return spellings.some((spelling) => haystack.includes(spelling));
};

/** Search decoded JSON strings, including Unicode escapes, without retaining whole string values. */
const jsonEscapedSecrets = (
  bytes: Uint8Array,
  secrets: readonly KnownSecret[],
): Set<string> => {
  const found = new Set<string>();
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  let text: string | undefined;
  if (buffer.includes(Buffer.from("\\u"))) text = decodeStateText(bytes);
  if (text === undefined) {
    const hasAligned = (marker: Buffer) => {
      for (
        let at = buffer.indexOf(marker);
        at !== -1;
        at = buffer.indexOf(marker, at + 1)
      )
        if (at % 2 === 0) return true;
      return false;
    };
    const decoder = hasAligned(UTF16LE_ESCAPE_MARKER)
      ? UTF16LE_FATAL
      : hasAligned(UTF16BE_ESCAPE_MARKER)
        ? UTF16BE_FATAL
        : undefined;
    if (decoder !== undefined) {
      try {
        text = decoder.decode(bytes);
      } catch {
        return found;
      }
    }
  }
  if (text === undefined) return found;
  const longest = secrets.reduce(
    (max, { value }) => Math.max(max, value.length),
    0,
  );
  let window = "";
  let nestedWindow = "";
  let pending = "";
  const scan = (chunk: string, nested: boolean) => {
    const joined = (nested ? nestedWindow : window) + chunk;
    for (const { handle, value } of secrets)
      if (!found.has(handle) && joined.includes(value)) found.add(handle);
    const tail = joined.slice(-Math.max(longest - 1, 0));
    if (nested) nestedWindow = tail;
    else window = tail;
  };
  const nested = (chunk: string, end: boolean) => {
    const source = pending + chunk;
    let at = 0;
    let decoded = "";
    while (at < source.length) {
      if (!end && source[at] === "\\" && source.length - at < 6) break;
      if (
        source[at] === "\\" &&
        source[at + 1] === "u" &&
        /^[0-9a-fA-F]{4}$/u.test(source.slice(at + 2, at + 6))
      ) {
        decoded += String.fromCharCode(
          Number.parseInt(source.slice(at + 2, at + 6), 16),
        );
        at += 6;
      } else decoded += source[at++] ?? "";
    }
    pending = source.slice(at);
    scan(decoded, true);
  };
  for (const chunk of jsonStringChunks(text, Math.max(8192, longest))) {
    if (chunk.first) {
      nested("", true);
      window = "";
      nestedWindow = "";
      pending = "";
    }
    scan(chunk.text, false);
    nested(chunk.text, false);
  }
  nested("", true);
  return found;
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
  const json = jsonEscapedSecrets(bytes, scanned);
  if (inside?.ok === true)
    for (const handle of jsonEscapedSecrets(inside.value, scanned))
      json.add(handle);
  return scanned.flatMap(({ handle, value }) => {
    const spellings = byteSpellings(value);
    return json.has(handle) ||
      holds(bytes, spellings) ||
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
