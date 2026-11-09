import type { Element, Node } from "@xmldom/xmldom";

import { isExactJsonNumber } from "../exactJsonNumber.js";
import { MAX_JSON_DEPTH, type JsonValue } from "../jsonValue.js";
import { err, ok, type Result } from "../result.js";
import { safeParseJson } from "../safeJson.js";
import {
  declaredDocumentType,
  isWellFormedXml,
  opensLikeXml,
  parseXmlDocument,
} from "../xmlDocument.js";
import { expatXmlName } from "./expatXmlNames.js";

/** Formats the state view reads into JSON. */
export type DesktopStateFormat =
  | "text"
  | "json"
  | "keyfile"
  | "xml"
  | "sqlite"
  | "dconf"
  | "zip"
  | "binary";

const SQLITE_HEADER = "SQLite format 3\0";
/** Files beside a SQLite database that hold or undo its committed changes. */
export const SQLITE_SIDECARS = [
  { suffix: "-wal", label: "write-ahead log" },
  { suffix: "-journal", label: "rollback journal" },
] as const;
const GVDB_HEADER = "GVariant";
/** A zip archive's local file header, which FreeCAD, ODF, OOXML, EPUB and JAR files begin with. */
const ZIP_HEADER = "PK\u0003\u0004";
const XML_EXTENSIONS = /\.(?:xml|xbel|plist|svg|ui)$/iu;
/** A DOCTYPE that only names its DTD reads as XML; one with an internal subset, which can declare entities, does not. */
const XML_POLICY = {
  doctype: "external",
  lineEndings: "normalize",
  nameSupported: expatXmlName,
} as const;
const MAX_TEXT_LINES = 5000;
const MAX_XML_NODES = 5000;
const MAX_XML_DEPTH = 64;
/** Half of Evidence's nesting limit, leaving room for the result around a view. */
const MAX_JSON_VIEW_DEPTH = MAX_JSON_DEPTH / 2;
const MIB = 1024 * 1024;
/** Largest JSON or key file read into a view, whose whole value enters Evidence. */
const MAX_PARSED_VIEW_BYTES = 4 * MIB;

type KeyfileLine =
  | { readonly kind: "skip" }
  | { readonly kind: "group"; readonly name: string }
  | { readonly kind: "entry"; readonly key: string; readonly value: string }
  | { readonly kind: "other" };

/** One key file line: blank or comment, `[group]`, `key=value`, or anything else. */
const keyfileLine = (raw: string): KeyfileLine => {
  const line = raw.trim();
  if (line.length === 0 || line.startsWith("#") || line.startsWith(";"))
    return { kind: "skip" };
  const name = /^\[(?<name>[^\]]+)\]$/u.exec(line)?.groups?.name;
  if (name !== undefined) return { kind: "group", name };
  const equals = raw.indexOf("=");
  if (equals < 0) return { kind: "other" };
  const key = raw.slice(0, equals).trim();
  return key.length === 0
    ? { kind: "other" }
    : {
        kind: "entry",
        key,
        // Only ASCII space and tab immediately after '=' are padding.
        value: raw.slice(equals + 1).replace(/^[ \t]+/u, ""),
      };
};

/**
 * A key file has at least one group and nothing a key file view would drop.
 * Lines are read one at a time, stopping at the first that is neither.
 */
const isKeyfile = (text: string): boolean => {
  let group = false;
  for (let start = 0; start <= text.length;) {
    const end = text.indexOf("\n", start);
    const kind = keyfileLine(text.slice(start, end < 0 ? undefined : end)).kind;
    if (kind === "other") return false;
    if (kind === "group") group = true;
    if (end < 0) break;
    start = end + 1;
  }
  return group;
};

/** Decode bytes as UTF-8 text, or undefined for binary content. */
export const decodeStateText = (bytes: Uint8Array): string | undefined => {
  if (bytes.subarray(0, 8192).includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;
const JSON_HEX4 = /[0-9a-fA-F]{4}/uy;
const JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

/** Where the JSON string opening at `start` ends, past its closing quote, or -1 when it is malformed. */
const jsonStringEnd = (text: string, start: number): number => {
  for (let at = start + 1; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code === 0x22) return at + 1;
    if (code < 0x20) return -1;
    if (code === 0x5c) {
      const escape = text.charAt(at + 1);
      JSON_HEX4.lastIndex = at + 2;
      if (escape === "u" && JSON_HEX4.test(text)) at += 5;
      else if (JSON_ESCAPES.has(escape)) at += 1;
      else return -1;
    }
  }
  return -1;
};

/** Where the JSON string, number or literal starting at `start` ends, or -1 when none does. */
const jsonScalarEnd = (text: string, start: number): number => {
  if (text.charCodeAt(start) === 0x22) return jsonStringEnd(text, start);
  for (const literal of ["true", "false", "null"])
    if (text.startsWith(literal, start)) return start + literal.length;
  JSON_NUMBER.lastIndex = start;
  return JSON_NUMBER.test(text) ? JSON_NUMBER.lastIndex : -1;
};

/** How far a JSON text has been read: what may come next, and the containers still open. */
interface JsonScan {
  expect: "value" | "key" | "colon" | "after";
  /** The innermost container was just opened, so it may close at once. */
  empty: boolean;
  /** Each open container's opening bracket, innermost at `depth - 1`. */
  open: Uint8Array;
  depth: number;
}

/** Open a container, growing the brackets held as it nests deeper. */
const openJson = (scan: JsonScan, bracket: number): void => {
  if (scan.depth === scan.open.length) {
    const grown = new Uint8Array(scan.open.length * 2);
    grown.set(scan.open);
    scan.open = grown;
  }
  scan.open[scan.depth] = bracket;
  scan.depth += 1;
  scan.expect = bracket === 0x5b ? "value" : "key";
  scan.empty = true;
};

/** Read one bracket, comma or colon into the scan; false when the text cannot hold it there. */
const jsonPunctuation = (scan: JsonScan, char: string): boolean => {
  const code = char.charCodeAt(0);
  const inner = scan.depth > 0 ? scan.open[scan.depth - 1] : undefined;
  switch (char) {
    case "[":
    case "{":
      if (scan.expect !== "value") return false;
      openJson(scan, code);
      return true;
    case "]":
    case "}":
      // A closing bracket's code is its opening's plus two.
      if ((scan.expect !== "after" && !scan.empty) || inner !== code - 2)
        return false;
      scan.depth -= 1;
      break;
    case ",":
      if (scan.expect !== "after" || inner === undefined) return false;
      scan.expect = inner === 0x5b ? "value" : "key";
      return true;
    default:
      if (scan.expect !== "colon") return false;
      scan.expect = "value";
      return true;
  }
  scan.expect = "after";
  scan.empty = false;
  return true;
};

/** Read a string, number or literal into the scan; false when the text cannot hold it there. */
const jsonScalar = (scan: JsonScan, string: boolean): boolean => {
  if (scan.expect === "value") scan.expect = "after";
  else if (string && scan.expect === "key") scan.expect = "colon";
  else return false;
  scan.empty = false;
  return true;
};

/**
 * Whether text is one JSON value as `JSON.parse` reads it, checked a token at
 * a time without building the value: it holds a byte per open container, so
 * text too large to parse into a view is still told apart from other text.
 */
export const isJsonText = (text: string): boolean => {
  const scan: JsonScan = {
    expect: "value",
    empty: false,
    open: new Uint8Array(64),
    depth: 0,
  };
  for (let at = 0; at < text.length;) {
    const char = text.charAt(at);
    if (" \t\n\r".includes(char)) at += 1;
    else if ("[]{},:".includes(char)) {
      if (!jsonPunctuation(scan, char)) return false;
      at += 1;
    } else {
      at = jsonScalarEnd(text, at);
      if (at < 0 || !jsonScalar(scan, char === '"')) return false;
    }
  }
  return scan.expect === "after" && scan.depth === 0;
};

/** Whether a file's name or leading text marks it as JSON, which it is if it parses. */
const namedJson = (path: string, trimmed: string): boolean =>
  path.toLowerCase().endsWith(".json") || /^[[{]/u.test(trimmed);

/** Whether a file's name or XML declaration marks it as XML, which it is if it parses. */
const namedXml = (path: string, trimmed: string): boolean =>
  XML_EXTENSIONS.test(path) || trimmed.startsWith("<?xml");

/**
 * Whether text opens with an element, as a Freeplane map's `<map version=…>`
 * without a declaration, or with a DOCTYPE that has no internal subset and
 * then an element, as KmPlot's `<!DOCTYPE kmpdoc><kmpdoc …>`, so it is XML
 * if it is well formed, whatever the file is called. A DOCTYPE with an
 * internal subset, which may declare entities, never opens one.
 */
/**
 * Whether a DOCTYPE before `>` opens an internal subset. A `[` inside a
 * quoted system or public id, as `state[1].dtd`, does not.
 */
const doctypeOpensSubset = (text: string, from: number): boolean => {
  let quote = "";
  for (let index = from; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (quote !== "") {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "[") return true;
    else if (character === ">") return false;
  }
  return false;
};

const opensElement = (trimmed: string): boolean => {
  if (!trimmed.startsWith("<!DOCTYPE") && opensLikeXml(trimmed)) return true;
  const declared = /^(?:<\?xml[^>]*>\s*)?<!DOCTYPE\b/u.exec(trimmed);
  if (declared === null) return false;
  let quote = "";
  for (let index = declared[0].length; index < trimmed.length; index += 1) {
    const character = trimmed[index] ?? "";
    if (quote !== "") {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "[") return false;
    else if (character === ">") {
      const rest = trimmed.slice(index + 1).trimStart();
      return opensLikeXml(rest);
    }
  }
  return false;
};

/** Whether `opening` has a DOCTYPE whose internal subset starts outside quotes. */
export const doctypeHasInternalSubset = (opening: string): boolean => {
  const declared = /^(?:<\?xml[^>]*>\s*)?<!DOCTYPE\b/u.exec(opening);
  return declared !== null && doctypeOpensSubset(opening, declared[0].length);
};

/**
 * Whether decoded text is JSON or XML as `detectStateFormat` reads it, told
 * by syntax alone so no value or document is built: JSON a token at a time
 * and XML by its well-formedness pass, each holding only what is open.
 */
export const textSyntaxFormat = (
  path: string,
  text: string,
): "json" | "xml" | "text" => {
  const trimmed = text.trimStart();
  if (namedJson(path, trimmed) && isJsonText(text)) return "json";
  if (
    (namedXml(path, trimmed) || opensElement(trimmed)) &&
    isWellFormedXml(text, XML_POLICY)
  )
    return "xml";
  return "text";
};

/** Pick the reader for one retained file from its leading bytes and name. */
export const detectStateFormat = (
  path: string,
  bytes: Uint8Array,
): DesktopStateFormat => {
  const header = new TextDecoder("latin1").decode(bytes.subarray(0, 16));
  if (header === SQLITE_HEADER) return "sqlite";
  if (header.startsWith(GVDB_HEADER)) return "dconf";
  if (header.startsWith(ZIP_HEADER)) return "zip";
  const text = decodeStateText(bytes);
  if (text === undefined) return "binary";
  const trimmed = text.trimStart();
  if (
    namedJson(path, trimmed) &&
    // JSON too large for a view is told apart without building its value.
    (bytes.length > MAX_PARSED_VIEW_BYTES
      ? isJsonText(text)
      : safeParseJson(text).ok)
  )
    return "json";
  // Check syntax without constructing a document for format detection.
  if (namedXml(path, trimmed) || opensElement(trimmed))
    return isWellFormedXml(text, XML_POLICY) ? "xml" : "text";
  return isKeyfile(text) ? "keyfile" : "text";
};

/** An object's own values one at a time, without copying them into an array. */
function* ownValues(record: Record<string, JsonValue>): Generator<JsonValue> {
  for (const key in record)
    if (Object.hasOwn(record, key)) yield record[key] ?? null;
}

/**
 * Whether a parsed JSON value nests deeper than a limit, checked without
 * recursion: a value's depth is the number of levels open above it, each
 * walked by one iterator, so no container's members are copied or queued.
 */
export const deeperThan = (root: JsonValue, limit: number): boolean => {
  const levels: Iterator<JsonValue>[] = [[root].values()];
  for (let level = levels.at(-1); level !== undefined; level = levels.at(-1)) {
    const next = level.next();
    if (next.done === true) levels.pop();
    else if (levels.length - 1 > limit) return true;
    else if (Array.isArray(next.value)) levels.push(next.value.values());
    else if (typeof next.value === "object" && next.value !== null)
      levels.push(ownValues(next.value));
  }
  return false;
};

/** A JSON file's value, refused when a number would be rounded or it nests too deeply. */
export const jsonView = (text: string): Result<JsonValue, string> => {
  let rounded = false;
  const parsed = safeParseJson(text, (_key, value, context) => {
    if (typeof value === "number" && !isExactJsonNumber(value, context?.source))
      rounded = true;
    return value;
  });
  if (!parsed.ok) return err(parsed.error);
  if (rounded)
    return err(
      "a number in it cannot be read exactly, such as an integer above 2^53",
    );
  const value = parsed.value as JsonValue;
  return deeperThan(value, MAX_JSON_VIEW_DEPTH)
    ? err(
        `nested deeper than the ${String(MAX_JSON_VIEW_DEPTH)} levels a JSON view keeps`,
      )
    : ok(value);
};

/** A text file as lines, bounded. */
export const textView = (text: string): JsonValue => {
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return {
    lines: lines.slice(0, MAX_TEXT_LINES),
    line_count: lines.length,
    truncated: lines.length > MAX_TEXT_LINES,
  };
};

/** A dictionary without inherited properties, so captured keys such as `__proto__` stay plain data. */
export const plainRecord = <Value>(): Record<string, Value> =>
  Object.create(null) as Record<string, Value>;

/**
 * An INI-style key file (desktop entries, GLib key files, `dconf dump`) as
 * groups of string values. Keys before the first group sit in group "".
 */
export const keyfileView = (
  text: string,
): Record<string, Record<string, string>> => {
  const groups = plainRecord<Record<string, string>>();
  let group = "";
  for (const raw of text.split(/\r?\n/u)) {
    const line = keyfileLine(raw);
    if (line.kind === "group") {
      group = line.name;
      groups[group] ??= plainRecord();
    } else if (line.kind === "entry")
      (groups[group] ??= plainRecord())[line.key] = line.value;
  }
  return groups;
};

interface XmlBudget {
  remaining: number;
  truncated: boolean;
}

/** What a node's parent establishes about whitespace, computed once per element. */
interface XmlScope {
  /** `xml:space="preserve"` applies. */
  readonly preserve: boolean;
  /**
   * The parent holds child elements and no text but whitespace, so whitespace-only
   * text between them is formatting; in mixed content, text beside elements, it is text.
   */
  readonly elementContent: boolean;
}

/** XML's whitespace: space, tab, carriage return and line feed, not Unicode's wider set. */
const XML_WHITESPACE = /^[ \t\r\n]*$/u;

const isTextNode = (node: Node): boolean =>
  node.nodeType === node.TEXT_NODE || node.nodeType === node.CDATA_SECTION_NODE;

/** Whether an element holds child elements and no text but whitespace beside them. */
const holdsElementContent = (element: Element): boolean => {
  let elements = false;
  for (
    let child = element.firstChild;
    child !== null;
    child = child.nextSibling
  )
    if (child.nodeType === child.ELEMENT_NODE) elements = true;
    else if (isTextNode(child) && !XML_WHITESPACE.test(child.nodeValue ?? ""))
      return false;
  return elements;
};

const xmlNode = (
  node: Node,
  depth: number,
  budget: XmlBudget,
  scope: XmlScope,
): JsonValue | undefined => {
  if (budget.remaining <= 0 || depth > MAX_XML_DEPTH) {
    budget.truncated = true;
    return undefined;
  }
  budget.remaining -= 1;
  if (isTextNode(node)) {
    const text = node.nodeValue ?? "";
    return XML_WHITESPACE.test(text) && scope.elementContent && !scope.preserve
      ? undefined
      : text;
  }
  if (node.nodeType !== node.ELEMENT_NODE) return undefined;
  const element = node as Element;
  const attributes = plainRecord<string>();
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (attribute !== null) attributes[attribute.name] = attribute.value;
  }
  const space = element.getAttribute("xml:space");
  const inner: XmlScope = {
    preserve:
      space === null || space === "" ? scope.preserve : space === "preserve",
    elementContent: holdsElementContent(element),
  };
  const children: JsonValue[] = [];
  for (
    let child = element.firstChild;
    child !== null;
    child = child.nextSibling
  ) {
    const value = xmlNode(child, depth + 1, budget, inner);
    if (value !== undefined) children.push(value);
  }
  return { name: element.tagName, attributes, children };
};

/**
 * An XML document as a bounded element tree. A DOCTYPE that only names its DTD
 * is recorded as `doctype`, its DTD never read; one with an internal subset is
 * refused, as is a reference to any entity but XML's five.
 */
export const xmlView = (text: string): JsonValue | undefined => {
  const parsed = parseXmlDocument(text, XML_POLICY);
  const root = parsed.ok ? parsed.value.documentElement : null;
  if (!parsed.ok || root === null) return undefined;
  const budget: XmlBudget = { remaining: MAX_XML_NODES, truncated: false };
  const tree = xmlNode(root, 0, budget, {
    preserve: false,
    elementContent: false,
  });
  if (tree === undefined) return undefined;
  const doctype = declaredDocumentType(parsed.value);
  return {
    ...(doctype === undefined
      ? {}
      : {
          doctype: {
            name: doctype.name,
            public_id: doctype.publicId,
            system_id: doctype.systemId,
          },
        }),
    root: tree,
    truncated: budget.truncated,
  };
};

/** Formats read from a file's bytes alone, without a tool or worker. */
export type TextualStateFormat = "text" | "json" | "keyfile" | "xml";

/** Whether a format is one of the text formats, read as UTF-8. */
export const isTextualFormat = (
  format: string | null,
): format is TextualStateFormat =>
  format === "text" ||
  format === "json" ||
  format === "keyfile" ||
  format === "xml";

/** A text, JSON, key file or XML file's view, or why it has none. */
export const textualView = (
  format: TextualStateFormat,
  bytes: Uint8Array,
): Result<JsonValue, string> => {
  if (
    (format === "json" || format === "keyfile") &&
    bytes.length > MAX_PARSED_VIEW_BYTES
  )
    return err(
      `larger than the ${String(MAX_PARSED_VIEW_BYTES / MIB)} MiB limit for JSON and key file views`,
    );
  const text = decodeStateText(bytes) ?? "";
  switch (format) {
    case "text":
      return ok(textView(text));
    case "json":
      return jsonView(text);
    case "keyfile":
      return ok({ groups: keyfileView(text) });
    case "xml": {
      const tree = xmlView(text);
      return tree === undefined
        ? err("not well-formed XML, or its DOCTYPE has an internal subset")
        : ok(tree);
    }
  }
};
