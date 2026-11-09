import type { JsonValue } from "../jsonValue.js";
import {
  gunzip,
  gzipDeterministic,
  hasExtraField,
  isGzip,
} from "./gzipDocument.js";
import {
  identityLeftIn,
  identitySpellings,
  scrubHostIdentity,
  type HostIdentity,
} from "./hostIdentity.js";
import {
  detectStateFormat,
  isTextualFormat,
  textSyntaxFormat,
} from "./stateFormats.js";

/** What the export ships for one seed. */
export interface SeedScrub {
  /** The rewritten bytes, or undefined when the seed ships as captured. */
  readonly bytes: Buffer | undefined;
  /** Whether what it ships still holds the captured home, `user@host` or the host name, its escapes decoded. */
  readonly holdsIdentity: boolean;
  /** The bytes are a gzip file compressed again only to clear its header: its document is as captured. */
  readonly recompressed?: true;
}

/** Seeds up to this size are decoded, well inside a JavaScript string; a larger one is only searched byte for byte. */
const MAX_SCRUBBED_BYTES = 256 * 1024 * 1024;

/** A text with the identity scrubbed, and the text a search for what is left reads, its escapes decoded. */
interface TextScrub {
  readonly text: string;
  readonly decoded: string;
}

/** Whitespace JSON allows between tokens. */
const JSON_SPACE = new Set([" ", "\t", "\n", "\r"]);

/** Where the string literal opening at `start` ends, just past its closing quote: the first of its quotes no odd run of backslashes escapes, or -1. */
const stringEnd = (text: string, start: number): number => {
  const mark = text[start] ?? "";
  for (let quote = text.indexOf(mark, start + 1); quote !== -1;) {
    let slashes = 0;
    while (text[quote - 1 - slashes] === "\\") slashes += 1;
    if (slashes % 2 === 0) return quote + 1;
    quote = text.indexOf(mark, quote + 1);
  }
  return -1;
};

/** Whether the token after a string literal is a colon, which makes it a member name or dictionary key. */
const isMemberName = (text: string, end: number): boolean => {
  let next = end;
  while (JSON_SPACE.has(text[next] ?? "")) next += 1;
  return text[next] === ":";
};

/**
 * JSON with each string value scrubbed as its decoded value and rewritten
 * only when that changed, so names, literals, numbers and other strings keep
 * their spelling. A name is never rewritten, since two could then collide;
 * one holding the identity is left for the search for what is left. The
 * document, already read as JSON, is walked one string at a time, so a long
 * string costs no more stack than a short one.
 */
const scrubJson = (text: string, identity: HostIdentity): TextScrub => {
  const parts: string[] = [];
  const strings: string[] = [];
  let copied = 0;
  for (let start = text.indexOf('"'); start !== -1;) {
    const end = stringEnd(text, start);
    if (end === -1) break;
    const value = JSON.parse(text.slice(start, end)) as string;
    const clean = isMemberName(text, end)
      ? value
      : scrubHostIdentity(value, identity);
    strings.push(clean);
    if (clean !== value) {
      parts.push(text.slice(copied, start), JSON.stringify(clean));
      copied = end;
    }
    start = text.indexOf('"', end);
  }
  parts.push(text.slice(copied));
  const scrubbed = parts.join("");
  return { text: scrubbed, decoded: [scrubbed, ...strings].join("\n") };
};

/** Comments, CDATA sections, processing instructions and tags of a document already read as XML; the rest is character data. */
const XML_MARKUP =
  /<!--([\s\S]*?)-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/gu;
const XML_VALUE = /"([^"]*)"|'([^']*)'/gu;
const XML_REFERENCE =
  /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(lt|gt|amp|quot|apos));/gu;
const XML_ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/** A character reference's character, or the reference as written when it names no Unicode code point. */
const referenced = (whole: string, point: number): string =>
  point <= 0x10ffff ? String.fromCodePoint(point) : whole;

const decodeXml = (text: string, quote?: string): string => {
  const normalized =
    quote !== undefined
      ? text.replace(/\r\n|[\r\n\t]/gu, " ")
      : text.replace(/\r\n|\r/gu, "\n");
  return normalized.replace(
    XML_REFERENCE,
    (whole, hex?: string, decimal?: string, name?: string) =>
      hex !== undefined
        ? referenced(whole, Number.parseInt(hex, 16))
        : decimal !== undefined
          ? referenced(whole, Number(decimal))
          : (XML_ENTITIES[name ?? ""] ?? whole),
  );
};

/** Character data, or an attribute value in the given quote, escaped so XML reads it back as written. */
const encodeXml = (text: string, quote: string | undefined): string =>
  text.replace(/[&<>\r\t\n"']/gu, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === "\r") return "&#13;";
    if (quote === undefined || (character !== quote && character.trim() !== ""))
      return character;
    return `&#${String(character.codePointAt(0))};`;
  });

/**
 * XML with character data, attribute values, comments and CDATA scrubbed,
 * character data and attribute values as their decoded text and rewritten
 * only when that changed; names and processing instructions are kept. Only
 * changed spans are copied out, so however many elements the document has,
 * the scrub holds no more than its changes.
 */
const scrubXml = (text: string, identity: HostIdentity): TextScrub => {
  const data = (raw: string, quote?: string) => {
    const value = decodeXml(raw, quote);
    const clean = scrubHostIdentity(value, identity);
    return clean === value ? raw : encodeXml(clean, quote);
  };
  const parts: string[] = [];
  let copied = 0;
  /** Replace the span at `start` written `raw` with `clean` when they differ. */
  const replace = (start: number, raw: string, clean: string) => {
    if (clean === raw) return;
    parts.push(text.slice(copied, start), clean);
    copied = start + raw.length;
  };
  let end = 0;
  for (const match of text.matchAll(XML_MARKUP)) {
    const [markup, comment, cdata] = match;
    const characters = text.slice(end, match.index);
    replace(end, characters, data(characters));
    end = match.index + markup.length;
    if (comment !== undefined)
      replace(
        match.index,
        markup,
        `<!--${scrubHostIdentity(comment, identity)}-->`,
      );
    else if (cdata !== undefined)
      replace(
        match.index,
        markup,
        `<![CDATA[${scrubHostIdentity(cdata, identity)}]]>`,
      );
    else if (!markup.startsWith("<?"))
      replace(
        match.index,
        markup,
        markup.replace(XML_VALUE, (_value, double?: string, single?: string) =>
          double === undefined
            ? `'${data(single ?? "", "'")}'`
            : `"${data(double, '"')}"`,
        ),
      );
  }
  const rest = text.slice(end);
  replace(end, rest, data(rest));
  parts.push(text.slice(copied));
  const scrubbed = parts.join("");
  return { text: scrubbed, decoded: decodeXml(scrubbed) };
};

/** GVariant escapes that stand for one character, as `g_variant_parse` reads them; a backslash before a line break joins lines. */
const GVARIANT_ESCAPES: Readonly<Record<string, string>> = {
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\n": "",
};
const GVARIANT_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([\s\S]))/gu;
/** What, outside quotes, types a GVariant literal as an object path or signature rather than a string. */
const GVARIANT_PATH_OR_SIGNATURE =
  /\b(?:objectpath|signature)\b|@[a-z(){}]*[og]/u;

/** Whether a code point is one a GVariant string can hold: not NUL, a surrogate or past Unicode. */
const isCharacter = (point: number): boolean =>
  point > 0 && point <= 0x10ffff && (point < 0xd800 || point >= 0xe000);

/** A GVariant string literal's body decoded, or undefined where `g_variant_parse` refuses it. */
const decodeGVariant = (body: string): string | undefined => {
  let refused = body.includes("\0");
  const value = body.replace(
    GVARIANT_ESCAPE,
    (_escape, short?: string, long?: string, other?: string) => {
      if (other !== undefined) {
        refused ||= other === "u" || other === "U";
        return GVARIANT_ESCAPES[other] ?? other;
      }
      const point = Number.parseInt(short ?? long ?? "0", 16);
      if (isCharacter(point)) return String.fromCodePoint(point);
      refused = true;
      return "";
    },
  );
  return refused ? undefined : value;
};

/** A GVariant string literal in the given quote, escaping what would end it or break its key file line. */
const encodeGVariant = (value: string, quote: string): string =>
  `${quote}${value.replace(/[\\'"\p{Cc}]/gu, (character) => {
    if (character === "\\" || character === quote) return `\\${character}`;
    if (character === "'" || character === '"') return character;
    return `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
  })}${quote}`;

/** Whether the literal opening at `start` is a bytestring, its `b` starting a token. */
const isBytestring = (text: string, start: number): boolean =>
  text[start - 1] === "b" && !/[A-Za-z0-9]/u.test(text[start - 2] ?? "");

/**
 * A dconf value, GVariant text as `dconf dump` prints it, with each string
 * scrubbed as its decoded value and rewritten only when that changed, as JSON
 * strings are: dictionary keys, bytestrings and everything outside quotes
 * keep their spelling. Undefined, so the value ships as captured, when a
 * literal does not parse or the value holds an object path or signature,
 * whose quoted literals are not strings.
 */
const scrubGVariant = (
  text: string,
  identity: HostIdentity,
): TextScrub | undefined => {
  const parts: string[] = [];
  const strings: string[] = [];
  const quotes = /['"]/gu;
  let outside = "";
  let last = 0;
  let copied = 0;
  for (
    let match = quotes.exec(text);
    match !== null;
    match = quotes.exec(text)
  ) {
    const start = match.index;
    const end = stringEnd(text, start);
    if (end === -1) return undefined;
    outside += ` ${text.slice(last, start)}`;
    last = end;
    quotes.lastIndex = end;
    if (isBytestring(text, start)) continue;
    const value = decodeGVariant(text.slice(start + 1, end - 1));
    if (value === undefined) return undefined;
    const clean = isMemberName(text, end)
      ? value
      : scrubHostIdentity(value, identity);
    strings.push(clean);
    if (clean !== value) {
      parts.push(text.slice(copied, start), encodeGVariant(clean, match[0]));
      copied = end;
    }
  }
  if (GVARIANT_PATH_OR_SIGNATURE.test(`${outside} ${text.slice(last)}`))
    return undefined;
  parts.push(text.slice(copied));
  const scrubbed = parts.join("");
  return { text: scrubbed, decoded: [scrubbed, ...strings].join("\n") };
};

const isRecord = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A dconf view's groups as the key file the computer compiles, each value's
 * strings scrubbed, and whether it still holds the identity, strings decoded.
 * Group names and keys are kept, so no two can collide; a value that does
 * not parse ships as captured.
 */
export const scrubDconf = (
  groups: Readonly<Record<string, JsonValue>>,
  identity: HostIdentity,
): { readonly text: string; readonly holdsIdentity: boolean } => {
  const lines: string[] = [];
  const decoded: string[] = [];
  for (const [group, keys] of Object.entries(groups)) {
    if (!isRecord(keys)) continue;
    lines.push(`[${group}]`);
    for (const [key, value] of Object.entries(keys)) {
      if (typeof value !== "string") continue;
      const scrub = scrubGVariant(value, identity);
      lines.push(`${key}=${scrub?.text ?? value}`);
      if (scrub !== undefined) decoded.push(scrub.decoded);
    }
    lines.push("");
  }
  const text = lines.join("\n");
  return {
    text,
    holdsIdentity:
      identityLeftIn([text, ...decoded].join("\n"), identity) !== undefined,
  };
};

/** Text and key files, which hold the identity as written. */
const plainScrub = (text: string, identity: HostIdentity): TextScrub => {
  const scrubbed = scrubHostIdentity(text, identity);
  return { text: scrubbed, decoded: scrubbed };
};

/** UTF-16 text after a byte-order mark, decoded and encoded as the computer's boot respelling does; undefined otherwise. */
const utf16Text = (bytes: Buffer) => {
  const order = [
    { mark: [0xff, 0xfe], swap: false },
    { mark: [0xfe, 0xff], swap: true },
  ].find(({ mark }) => mark.every((byte, index) => bytes[index] === byte));
  if (order === undefined) return undefined;
  const little = Buffer.from(bytes.subarray(2));
  if (order.swap && little.length % 2 === 0) little.swap16();
  try {
    return {
      // The signature is already removed; a leading U+FEFF here is content.
      text: new TextDecoder("utf-16le", {
        fatal: true,
        ignoreBOM: true,
      }).decode(little),
      encode: (scrubbed: string) => {
        const encoded = Buffer.from(scrubbed, "utf16le");
        if (order.swap) encoded.swap16();
        return Buffer.concat([Buffer.from(order.mark), encoded]);
      },
    };
  } catch {
    return undefined;
  }
};

/** A seed by its home path and the format the state view read it as. */
interface Seed {
  readonly home: string;
  readonly format: string | null;
}

/**
 * The seed's text, the format it is scrubbed as, and how to encode it again:
 * UTF-8 for a text format, or UTF-16 after a byte-order mark, JSON or XML as
 * its text would be in UTF-8, told by syntax alone so no view is built.
 */
const seedText = (bytes: Buffer, { home, format }: Seed) => {
  if (bytes.length > MAX_SCRUBBED_BYTES) return undefined;
  if (!isTextualFormat(format)) {
    const utf16 = utf16Text(bytes);
    return utf16 === undefined
      ? undefined
      : { ...utf16, format: textSyntaxFormat(home, utf16.text) };
  }
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    return {
      // The byte-order mark is kept, as Python's utf-8 codec keeps it.
      text,
      encode: (scrubbed: string) => Buffer.from(scrubbed, "utf8"),
      format: format === "text" ? textSyntaxFormat(home, text) : format,
    };
  } catch {
    return undefined;
  }
};

/** Whether bytes it does not rewrite hold the identity: read as Latin-1, so each byte is one character, or searched byte for byte past the size it decodes. */
const holdsIdentity = (bytes: Buffer, identity: HostIdentity): boolean => {
  if (bytes.length > MAX_SCRUBBED_BYTES)
    return identitySpellings(identity).some((spelling) =>
      bytes.includes(spelling),
    );
  const latin1 = (value: string | null) =>
    value === null ? null : Buffer.from(value).toString("latin1");
  return (
    identityLeftIn(bytes.toString("latin1"), {
      home: latin1(identity.home) ?? "",
      hostname: latin1(identity.hostname),
      user: latin1(identity.user),
    }) !== undefined
  );
};

/**
 * Rewrite a seed as the computer reads it at boot: a text format as UTF-8,
 * and another file as UTF-16 when it starts with a byte-order mark, keeping
 * the mark and byte order. JSON is scrubbed by its strings and XML by its
 * character data and attribute values, in either encoding, so neither's
 * syntax changes. Other bytes ship as captured. Either way what ships is
 * searched, its escapes decoded, for what is left.
 */
const scrubDocument = (
  bytes: Buffer,
  seed: Seed,
  identity: HostIdentity,
): SeedScrub => {
  const decoded = seedText(bytes, seed);
  if (decoded === undefined)
    return { bytes: undefined, holdsIdentity: holdsIdentity(bytes, identity) };
  const scrub =
    decoded.format === "json"
      ? scrubJson(decoded.text, identity)
      : decoded.format === "xml"
        ? scrubXml(decoded.text, identity)
        : plainScrub(decoded.text, identity);
  return {
    bytes: scrub.text === decoded.text ? undefined : decoded.encode(scrub.text),
    holdsIdentity: identityLeftIn(scrub.decoded, identity) !== undefined,
  };
};

/**
 * Scrub a seed as `scrubDocument` does; a gzip file's document uses its
 * captured format, or the format detected from decoded bytes when unknown,
 * then is compressed again alike on every host whether or not it changed, so no file name, comment or time in the
 * captured header ships. One already so ships as captured, as do one that
 * does not decompress within the size decoded and one whose document needs no
 * edit but a member of which has an extra field, where BGZF and dictzip index
 * their blocks; both are searched as their bytes.
 */
export const scrubSeed = (
  bytes: Buffer,
  seed: Seed,
  identity: HostIdentity,
): SeedScrub => {
  if (!isGzip(bytes)) return scrubDocument(bytes, seed, identity);
  const document = gunzip(bytes, MAX_SCRUBBED_BYTES);
  if (!document.ok)
    return { bytes: undefined, holdsIdentity: holdsIdentity(bytes, identity) };
  // The captured gzip may have exceeded the view's expansion-ratio limit;
  // once decoded for shipping, detect its document format at this boundary.
  const documentSeed =
    seed.format === null
      ? { ...seed, format: detectStateFormat(seed.home, document.value) }
      : seed;
  const scrub = scrubDocument(document.value, documentSeed, identity);
  if (scrub.bytes === undefined && hasExtraField(bytes))
    return {
      bytes: undefined,
      holdsIdentity: scrub.holdsIdentity || holdsIdentity(bytes, identity),
    };
  const shipped = gzipDeterministic(scrub.bytes ?? document.value);
  if (shipped.equals(bytes))
    return { bytes: undefined, holdsIdentity: scrub.holdsIdentity };
  return {
    bytes: shipped,
    holdsIdentity: scrub.holdsIdentity,
    ...(scrub.bytes === undefined ? { recompressed: true as const } : {}),
  };
};
