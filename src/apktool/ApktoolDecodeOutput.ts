import {
  DOMParser,
  type Document,
  type Element,
  type Node,
} from "@xmldom/xmldom";
import {
  isMap,
  isScalar,
  parseDocument,
  type Document as YamlDocument,
} from "yaml";

/** Project only the Apktool metadata fields REA publishes. */
export interface ApktoolMetadata {
  readonly versionName: string | null;
  readonly versionCode: string | null;
  readonly minSdkVersion: string | null;
  readonly targetSdkVersion: string | null;
}

const metaInfoTag = {
  tag: "tag:yaml.org,2002:brut.androlib.meta.MetaInfo",
  collection: "map" as const,
  resolve: (map: unknown) => map,
};

/**
 * Read values from Apktool's tagged metadata document. YAML's core schema
 * distinguishes null from quoted strings; numeric values use their source
 * range so version codes retain the spelling Apktool emitted.
 */
export const parseApktoolYml = (yml: string): ApktoolMetadata => {
  const document = parseDocument(yml, {
    schema: "core",
    customTags: [metaInfoTag],
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0)
    throw new TypeError(
      `apktool.yml is not valid Apktool metadata: ${document.errors[0]?.message ?? "YAML parse error"}`,
    );
  if (!isMap(document.contents))
    throw new TypeError("apktool.yml root must be an Apktool metadata mapping");
  return {
    versionName: yamlScalar(document, ["versionInfo", "versionName"], yml),
    versionCode: yamlScalar(document, ["versionInfo", "versionCode"], yml),
    minSdkVersion: yamlScalar(document, ["sdkInfo", "minSdkVersion"], yml),
    targetSdkVersion: yamlScalar(
      document,
      ["sdkInfo", "targetSdkVersion"],
      yml,
    ),
  };
};

/** Read the package attribute from the decoded Android manifest root. */
export const parseManifestPackage = (manifest: string): string | null => {
  const document = parseXml(manifest, "AndroidManifest.xml");
  const root = document.documentElement;
  if (root === null || root.nodeName !== "manifest") return null;
  return root.getAttribute("package") || null;
};

export interface DecodedStringEntry {
  readonly name: string;
  readonly value: string;
}

/**
 * Project direct `<string>` children from decoded resources XML. DOM parsing
 * identifies elements and attributes; text values are sliced from the input
 * at parser-reported locations so entity spelling and whitespace are kept.
 * Markup-bearing string values are omitted and counted as partial evidence.
 */
export const parseDecodedStrings = (
  stringsXml: string,
): {
  entries: readonly DecodedStringEntry[];
  unparsedCount: number;
} => {
  let document: Document;
  try {
    document = parseXml(stringsXml, "strings.xml");
  } catch {
    return { entries: [], unparsedCount: 1 };
  }
  const root = document.documentElement;
  if (root === null || root.nodeName !== "resources")
    return { entries: [], unparsedCount: 1 };

  const entries: DecodedStringEntry[] = [];
  let unparsedCount = 0;
  const offsets = sourceLineOffsets(stringsXml);
  for (const child of childNodes(root)) {
    if (child.nodeType !== 1) continue;
    const element = child as Element;
    if (element.nodeName !== "string") continue;
    const name = element.getAttribute("name");
    if (name === null || name.length === 0) {
      unparsedCount += 1;
      continue;
    }
    const content = childNodes(element);
    if (content.some((node) => node.nodeType !== 3 && node.nodeType !== 8)) {
      unparsedCount += 1;
      continue;
    }
    if (content.every((node) => node.nodeType === 8)) {
      entries.push({ name, value: "" });
      continue;
    }
    const value = content
      .filter((node) => node.nodeType === 3)
      .map((node) => {
        const start = sourceOffset(node, offsets);
        if (start === undefined) return null;
        // A literal '<' cannot appear in well-formed XML text. Ending here
        // also excludes comments after the document element from this value.
        const end = stringsXml.indexOf("<", start);
        if (end < start) return null;
        return stringsXml.slice(start, end);
      });
    if (value.some((part) => part === null)) {
      unparsedCount += 1;
      continue;
    }
    entries.push({ name, value: value.join("") });
  }
  return { entries, unparsedCount };
};

const yamlScalar = (
  document: YamlDocument,
  path: readonly string[],
  source: string,
): string | null => {
  const node = document.getIn(path, true);
  if (!isScalar(node) || node.value === null) return null;
  if (typeof node.value === "string") return node.value;
  const range = node.range;
  return range === null || range === undefined
    ? String(node.value)
    : source.slice(range[0], range[1]);
};

const parseXml = (xml: string, label: string) => {
  const errors: string[] = [];
  const document = new DOMParser({
    normalizeLineEndings: (source) => source,
    onError: (_level, message) => errors.push(message),
  }).parseFromString(xml, "application/xml");
  if (errors.length > 0 || document.documentElement === null)
    throw new TypeError(
      `${label} is not well-formed XML${errors[0] === undefined ? "" : `: ${errors[0]}`}`,
    );
  return document;
};

const childNodes = (node: Node): Node[] => {
  const children: Node[] = [];
  for (let child = node.firstChild; child !== null; child = child.nextSibling)
    children.push(child);
  return children;
};

const sourceLineOffsets = (source: string): readonly number[] => {
  const offsets = [0];
  for (const match of source.matchAll(/\r\n?|\n/gu)) {
    const index = match.index;
    offsets.push(index + match[0].length);
  }
  return offsets;
};

const sourceOffset = (
  node: Node,
  lineOffsets: readonly number[],
): number | undefined => {
  const line = node.lineNumber;
  const column = node.columnNumber;
  if (line === undefined || column === undefined) return undefined;
  const lineStart = lineOffsets[line - 1];
  return lineStart === undefined ? undefined : lineStart + column - 1;
};
