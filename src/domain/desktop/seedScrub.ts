import {
  identityLeftIn,
  identitySpellings,
  scrubHostIdentity,
  type HostIdentity,
} from "./hostIdentity.js";
import { isTextualFormat } from "./stateFormats.js";

/** What the export ships for one seed. */
export interface SeedScrub {
  /** The rewritten bytes, or undefined when the seed ships as captured. */
  readonly bytes: Buffer | undefined;
  /** Whether what it ships still holds the captured home, `user@host` or the host name, its escapes decoded. */
  readonly holdsIdentity: boolean;
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

/** Where the string literal opening at `start` ends, just past its closing quote: the first quote no odd run of backslashes escapes. */
const jsonStringEnd = (text: string, start: number): number => {
  for (let quote = text.indexOf('"', start + 1); quote !== -1;) {
    let slashes = 0;
    while (text[quote - 1 - slashes] === "\\") slashes += 1;
    if (slashes % 2 === 0) return quote + 1;
    quote = text.indexOf('"', quote + 1);
  }
  return text.length;
};

/** Whether the token after a string literal is a colon, which makes it a member name. */
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
    const end = jsonStringEnd(text, start);
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

const decodeXml = (text: string): string =>
  text.replace(
    XML_REFERENCE,
    (whole, hex?: string, decimal?: string, name?: string) =>
      hex !== undefined
        ? referenced(whole, Number.parseInt(hex, 16))
        : decimal !== undefined
          ? referenced(whole, Number(decimal))
          : (XML_ENTITIES[name ?? ""] ?? whole),
  );

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
 * only when that changed; names and processing instructions are kept.
 */
const scrubXml = (text: string, identity: HostIdentity): TextScrub => {
  const data = (raw: string, quote?: string) => {
    const value = decodeXml(raw);
    const clean = scrubHostIdentity(value, identity);
    return clean === value ? raw : encodeXml(clean, quote);
  };
  let scrubbed = "";
  let end = 0;
  for (const match of text.matchAll(XML_MARKUP)) {
    const [markup, comment, cdata] = match;
    scrubbed += data(text.slice(end, match.index));
    end = match.index + markup.length;
    if (comment !== undefined)
      scrubbed += `<!--${scrubHostIdentity(comment, identity)}-->`;
    else if (cdata !== undefined)
      scrubbed += `<![CDATA[${scrubHostIdentity(cdata, identity)}]]>`;
    else if (markup.startsWith("<?")) scrubbed += markup;
    else
      scrubbed += markup.replace(
        XML_VALUE,
        (_value, double?: string, single?: string) =>
          double === undefined
            ? `'${data(single ?? "", "'")}'`
            : `"${data(double, '"')}"`,
      );
  }
  scrubbed += data(text.slice(end));
  return { text: scrubbed, decoded: decodeXml(scrubbed) };
};

/** Text, key files and UTF-16 seeds, which hold the identity as written. */
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
      text: new TextDecoder("utf-16le", { fatal: true }).decode(little),
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

/** The seed's text and how to encode it again: UTF-8 for a text format, or UTF-16 after a byte-order mark. */
const seedText = (bytes: Buffer, format: string | null) => {
  if (bytes.length > MAX_SCRUBBED_BYTES) return undefined;
  if (!isTextualFormat(format)) return utf16Text(bytes);
  try {
    return {
      // The byte-order mark is kept, as Python's utf-8 codec keeps it.
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      ),
      encode: (scrubbed: string) => Buffer.from(scrubbed, "utf8"),
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
 * JSON by its strings and XML by its character data and attribute values so
 * neither's syntax changes, and another file as UTF-16 when it starts with a
 * byte-order mark. Other bytes ship as captured. Either way what ships is
 * searched, its escapes decoded, for what is left.
 */
export const scrubSeed = (
  bytes: Buffer,
  format: string | null,
  identity: HostIdentity,
): SeedScrub => {
  const decoded = seedText(bytes, format);
  if (decoded === undefined)
    return { bytes: undefined, holdsIdentity: holdsIdentity(bytes, identity) };
  const scrub =
    format === "json"
      ? scrubJson(decoded.text, identity)
      : format === "xml"
        ? scrubXml(decoded.text, identity)
        : plainScrub(decoded.text, identity);
  return {
    bytes: scrub.text === decoded.text ? undefined : decoded.encode(scrub.text),
    holdsIdentity: identityLeftIn(scrub.decoded, identity) !== undefined,
  };
};
