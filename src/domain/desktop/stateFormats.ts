import type { Element, Node } from "@xmldom/xmldom";

import type { JsonValue } from "../jsonValue.js";
import { safeParseJson } from "../safeJson.js";
import { parseXmlDocument } from "../xmlDocument.js";

/** Formats the state view reads into JSON. */
export type DesktopStateFormat =
  | "text"
  | "json"
  | "keyfile"
  | "xml"
  | "sqlite"
  | "dconf"
  | "binary";

const SQLITE_HEADER = "SQLite format 3\0";
const GVDB_HEADER = "GVariant";
const KEYFILE_EXTENSIONS = /\.(?:ini|conf|cfg|desktop|keyfile|rc)$/iu;
const XML_EXTENSIONS = /\.(?:xml|xbel|plist|svg|ui)$/iu;
const MAX_TEXT_LINES = 5000;
const MAX_XML_NODES = 5000;
const MAX_XML_DEPTH = 64;

/** Decode bytes as UTF-8 text, or undefined for binary content. */
export const decodeStateText = (bytes: Uint8Array): string | undefined => {
  if (bytes.subarray(0, 8192).includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

/** Pick the reader for one retained file from its leading bytes and name. */
export const detectStateFormat = (
  path: string,
  bytes: Uint8Array,
): DesktopStateFormat => {
  const header = new TextDecoder("latin1").decode(bytes.subarray(0, 16));
  if (header === SQLITE_HEADER) return "sqlite";
  if (header.startsWith(GVDB_HEADER)) return "dconf";
  const text = decodeStateText(bytes);
  if (text === undefined) return "binary";
  const trimmed = text.trimStart();
  if (
    (path.endsWith(".json") || /^[[{]/u.test(trimmed)) &&
    safeParseJson(text).ok
  )
    return "json";
  if (XML_EXTENSIONS.test(path) || trimmed.startsWith("<?xml"))
    return parseXmlDocument(text, {
      doctype: "reject",
      lineEndings: "normalize",
    }).ok
      ? "xml"
      : "text";
  if (KEYFILE_EXTENSIONS.test(path) || /^\[[^\]\n]+\]\s*$/mu.test(text))
    return "keyfile";
  return "text";
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
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";"))
      continue;
    const header = /^\[(?<name>[^\]]+)\]$/u.exec(line)?.groups?.name;
    if (header !== undefined) {
      group = header;
      groups[group] ??= plainRecord();
      continue;
    }
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    (groups[group] ??= plainRecord())[line.slice(0, equals).trim()] = line
      .slice(equals + 1)
      .trim();
  }
  return groups;
};

interface XmlBudget {
  remaining: number;
  truncated: boolean;
}

/** Whitespace-only text is formatting unless `xml:space="preserve"` applies. */
const preservesSpace = (node: Node): boolean => {
  for (
    let current: Node | null = node;
    current !== null;
    current = current.parentNode
  )
    if (current.nodeType === current.ELEMENT_NODE) {
      const space = (current as Element).getAttribute("xml:space");
      if (space === "preserve") return true;
      if (space === "default") return false;
    }
  return false;
};

const xmlNode = (
  node: Node,
  depth: number,
  budget: XmlBudget,
): JsonValue | undefined => {
  if (budget.remaining <= 0 || depth > MAX_XML_DEPTH) {
    budget.truncated = true;
    return undefined;
  }
  budget.remaining -= 1;
  if (
    node.nodeType === node.TEXT_NODE ||
    node.nodeType === node.CDATA_SECTION_NODE
  ) {
    const text = node.nodeValue ?? "";
    return text.trim().length === 0 && !preservesSpace(node) ? undefined : text;
  }
  if (node.nodeType !== node.ELEMENT_NODE) return undefined;
  const element = node as Element;
  const attributes = plainRecord<string>();
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (attribute !== null) attributes[attribute.name] = attribute.value;
  }
  const children: JsonValue[] = [];
  for (
    let child = element.firstChild;
    child !== null;
    child = child.nextSibling
  ) {
    const value = xmlNode(child, depth + 1, budget);
    if (value !== undefined) children.push(value);
  }
  return { name: element.tagName, attributes, children };
};

/** An XML document as a bounded element tree; DOCTYPEs are refused. */
export const xmlView = (text: string): JsonValue | undefined => {
  const parsed = parseXmlDocument(text, {
    doctype: "reject",
    lineEndings: "normalize",
  });
  const root = parsed.ok ? parsed.value.documentElement : null;
  if (root === null) return undefined;
  const budget: XmlBudget = { remaining: MAX_XML_NODES, truncated: false };
  const tree = xmlNode(root, 0, budget);
  return tree === undefined
    ? undefined
    : { root: tree, truncated: budget.truncated };
};
