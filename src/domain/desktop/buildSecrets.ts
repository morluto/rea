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
/** How far before a cut's ellipsis a scan looks for the start of a secret: past any cut a view makes, escaped twice. */
const MAX_CUT_LOOKBACK = 16 * 1024;
/** The most characters one secret holds, as one typed field takes. */
export const MAX_SECRET_CHARACTERS = 1024;
/** The most characters a setting's secret holds: a withheld file's bytes in base64. */
export const MAX_SETTING_CHARACTERS = 64 * 1024;
/** How much of a gzip file the scan decompresses to search inside it. */
const MAX_GUNZIPPED_BYTES = 64 * 1024 * 1024;

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

/** The value's spellings as text: as it is, escaped in XML and in JSON once or twice, in hex, in base64 at each alignment and in URL encoding. */
const textSpellings = (value: string): readonly string[] => {
  const bytes = Buffer.from(value, "utf8");
  const hex = bytes.toString("hex");
  const base64 = [0, 1, 2].map((offset) => base64Stable(bytes, offset));
  const url = encodeURIComponent(value);
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
  const scanned = secrets.filter(({ value }) => isScannableSecret(value));
  if (scanned.length === 0) return [];
  const inner = isGzip(bytes) ? gunzip(bytes, MAX_GUNZIPPED_BYTES) : undefined;
  return scanned.flatMap(({ handle, value }) => {
    const spellings = byteSpellings(value);
    return holds(bytes, spellings) ||
      (inner?.ok === true && holds(inner.value, spellings))
      ? [handle]
      : [];
  });
};

/** For each length of `pattern`'s prefixes, the longest proper prefix of it that also ends it. */
const borders = (pattern: string): number[] => {
  const table = [0];
  let length = 0;
  for (let index = 1; index < pattern.length; index += 1) {
    while (length > 0 && pattern[index] !== pattern[length])
      length = table[length - 1] ?? 0;
    if (pattern[index] === pattern[length]) length += 1;
    table.push(length);
  }
  return table;
};

/** How many characters of `text` before `end` begin `pattern`, as many as can, but never all of it. */
const prefixEndingAt = (
  text: string,
  end: number,
  pattern: string,
  table: readonly number[],
): number => {
  let length = 0;
  for (
    let index = Math.max(
      0,
      end - Math.min(pattern.length - 1, MAX_CUT_LOOKBACK),
    );
    index < end;
    index += 1
  ) {
    while (
      length > 0 &&
      (length === pattern.length || text[index] !== pattern[length])
    )
      length = table[length - 1] ?? 0;
    if (text[index] === pattern[length]) length += 1;
  }
  return length === pattern.length ? 0 : length;
};

/** Text with the start of a spelling a view cut short, just before the cut's ellipsis, replaced by its handle's placeholder. */
const redactCutSpellings = (
  text: string,
  spellings: readonly { readonly handle: string; readonly spelling: string }[],
): string => {
  if (!text.includes("…")) return text;
  const tables = spellings.map(({ spelling }) => borders(spelling));
  let redacted = "";
  let start = 0;
  for (
    let end = text.indexOf("…");
    end !== -1;
    end = text.indexOf("…", end + 1)
  ) {
    let longest = { length: 0, handle: "" };
    spellings.forEach(({ handle, spelling }, index) => {
      const length = prefixEndingAt(text, end, spelling, tables[index] ?? []);
      if (length > longest.length) longest = { length, handle };
    });
    if (longest.length === 0 || end - longest.length < start) continue;
    redacted += `${text.slice(start, end - longest.length)}${secretPlaceholder(longest.handle)}`;
    start = end;
  }
  return redacted + text.slice(start);
};

/** Text with each text spelling of each secret, longest first, replaced by its handle's placeholder, and any start of one a view cut short before its ellipsis. */
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
  return redactCutSpellings(
    spellings.reduce(
      (redacted, { handle, spelling }) =>
        redacted.replaceAll(spelling, secretPlaceholder(handle)),
      text,
    ),
    spellings,
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
