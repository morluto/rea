import type { Element, Node } from "@xmldom/xmldom";

import { isExactJsonNumber } from "../exactJsonNumber.js";
import { MAX_JSON_DEPTH, type JsonValue } from "../jsonValue.js";
import { err, ok, type Result } from "../result.js";
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
/** Files beside a SQLite database that hold or undo its committed changes. */
export const SQLITE_SIDECARS = [
  { suffix: "-wal", label: "write-ahead log" },
  { suffix: "-journal", label: "rollback journal" },
] as const;
const GVDB_HEADER = "GVariant";
const XML_EXTENSIONS = /\.(?:xml|xbel|plist|svg|ui)$/iu;
const MAX_TEXT_LINES = 5000;
const MAX_XML_NODES = 5000;
const MAX_XML_DEPTH = 64;
/** Half of Evidence's nesting limit, leaving room for the result around a view. */
const MAX_JSON_VIEW_DEPTH = MAX_JSON_DEPTH / 2;

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
  const equals = line.indexOf("=");
  return equals <= 0
    ? { kind: "other" }
    : {
        kind: "entry",
        key: line.slice(0, equals).trim(),
        value: line.slice(equals + 1).trim(),
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
  return isKeyfile(text) ? "keyfile" : "text";
};

/** Whether a parsed JSON value nests deeper than a limit, checked without recursion. */
const deeperThan = (root: JsonValue, limit: number): boolean => {
  const pending: [JsonValue, number][] = [[root, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [value, depth] = next;
    if (depth > limit) return true;
    if (typeof value === "object" && value !== null)
      for (const item of Object.values(value)) pending.push([item, depth + 1]);
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
  /** The parent holds child elements, so whitespace-only text between them is formatting. */
  readonly elementContent: boolean;
}

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
  if (
    node.nodeType === node.TEXT_NODE ||
    node.nodeType === node.CDATA_SECTION_NODE
  ) {
    const text = node.nodeValue ?? "";
    return text.trim().length === 0 && scope.elementContent && !scope.preserve
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
  let elementContent = false;
  for (
    let child = element.firstChild;
    child !== null && !elementContent;
    child = child.nextSibling
  )
    elementContent = child.nodeType === child.ELEMENT_NODE;
  const inner: XmlScope = {
    preserve:
      space === null || space === "" ? scope.preserve : space === "preserve",
    elementContent,
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

/** An XML document as a bounded element tree; DOCTYPEs are refused. */
export const xmlView = (text: string): JsonValue | undefined => {
  const parsed = parseXmlDocument(text, {
    doctype: "reject",
    lineEndings: "normalize",
  });
  const root = parsed.ok ? parsed.value.documentElement : null;
  if (root === null) return undefined;
  const budget: XmlBudget = { remaining: MAX_XML_NODES, truncated: false };
  const tree = xmlNode(root, 0, budget, {
    preserve: false,
    elementContent: false,
  });
  return tree === undefined
    ? undefined
    : { root: tree, truncated: budget.truncated };
};
