import type { Element, Node } from "@xmldom/xmldom";
import { parseXmlDocument } from "../domain/xmlDocument.js";
import { ok, err, type Result } from "../domain/result.js";
import {
  isMap,
  isScalar,
  parseDocument,
  type Document as YamlDocument,
} from "yaml";

/** Project only the Apktool metadata fields REA publishes. */
export interface ApktoolMetadata {
  readonly packageName: string | null;
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
 * Read the producer's metadata dialect once. Apktool 2.9.0 and later (including
 * 3) emit an untagged, line-oriented document with Java-escaped strings; older
 * tagged documents use YAML core semantics. Numeric values retain their source
 * spelling.
 */
export const parseApktoolYml = (yml: string): ApktoolMetadata => {
  const source = yml.replace(/^\uFEFF/u, "");
  const header = source.split(/\r\n?|\n/u, 1)[0] ?? "";
  if (
    /^version: (?:2\.(?:9|[1-9]\d)|3\.\d+)\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u.test(
      header,
    )
  )
    return parseApktool3Metadata(source);
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
    packageName: resolvePackageName(
      yamlScalar(document, ["packageInfo", "cur_package"], yml),
      yamlScalar(document, ["packageInfo", "orig_package"], yml),
      yamlScalar(document, ["packageInfo", "renameManifestPackage"], yml),
      yamlScalar(document, ["renameManifestPackage"], yml),
      yamlScalar(document, ["resourcesInfo", "packageName"], yml),
    ),
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

const apktool3Sections = new Set([
  "versionInfo",
  "sdkInfo",
  "packageInfo",
  "resourcesInfo",
]);

const apktool3ScalarPaths = new Set([
  "versionInfo.versionName",
  "versionInfo.versionCode",
  "sdkInfo.minSdkVersion",
  "sdkInfo.targetSdkVersion",
  "packageInfo.cur_package",
  "packageInfo.orig_package",
  "packageInfo.renameManifestPackage",
  "resourcesInfo.packageName",
]);

const resolvePackageName = (
  ...candidates: readonly (string | null | undefined)[]
): string | null => {
  for (const candidate of candidates) {
    if (
      candidate !== undefined &&
      candidate !== null &&
      candidate !== "" &&
      candidate !== "''" &&
      candidate !== '""' &&
      candidate !== "null" &&
      candidate !== "~"
    )
      return candidate;
  }
  return null;
};

/**
 * Apktool 3.0.3 YamlWriter, like the 2.9.0 writer it descends from, writes
 * strings without YAML quoting or comment syntax. Read its direct mapping
 * records before a YAML parser can discard hashes, consume quotes, or
 * reinterpret an empty string or literal `null`.
 */
const parseApktool3Metadata = (source: string): ApktoolMetadata => {
  const parsedFields = new Map<string, string>();
  const seenPaths = new Set<string>();
  const sections = new Set<string>();
  let section: string | undefined;
  for (const line of source.split(/\r\n?|\n/u)) {
    if (line.trim() === "" || /^[#!]/u.test(line)) continue;
    if (!line.startsWith(" ")) {
      const separator = line.indexOf(":");
      section = separator === -1 ? undefined : line.slice(0, separator);
      if (section === "version") {
        if (sections.has(section))
          throw new TypeError("apktool.yml has a duplicate producer version");
        sections.add(section);
        continue;
      }
      if (section === undefined || !apktool3Sections.has(section)) continue;
      if (line.slice(separator + 1).trim() !== "" || sections.has(section))
        throw new TypeError(`apktool.yml has an invalid ${section} mapping`);
      sections.add(section);
      continue;
    }
    const record = /^  ([^ :]+):(?: (.*))?$/su.exec(line);
    if (record === null) continue;
    const path = `${section ?? ""}.${record[1] ?? ""}`;
    if (!apktool3ScalarPaths.has(path)) continue;
    if (seenPaths.has(path))
      throw new TypeError(`apktool.yml has a duplicate ${path} field`);
    seenPaths.add(path);
    const value = record[2] ?? "";
    parsedFields.set(
      path,
      path === "versionInfo.versionCode" ? value : apktool3String(value),
    );
  }
  return {
    packageName: resolvePackageName(
      parsedFields.get("packageInfo.cur_package"),
      parsedFields.get("packageInfo.orig_package"),
      parsedFields.get("packageInfo.renameManifestPackage"),
      parsedFields.get("resourcesInfo.packageName"),
    ),
    versionName: parsedFields.get("versionInfo.versionName") ?? null,
    versionCode: parsedFields.get("versionInfo.versionCode") ?? null,
    minSdkVersion: parsedFields.get("sdkInfo.minSdkVersion") ?? null,
    targetSdkVersion: parsedFields.get("sdkInfo.targetSdkVersion") ?? null,
  };
};

const apktool3String = (source: string): string => {
  // The producer escapes every double quote. An unescaped opening double
  // quote therefore belongs to a standard quoted-YAML compatibility input.
  if (source.startsWith('"')) {
    const document = parseDocument(source, { schema: "core", strict: true });
    if (
      document.errors.length === 0 &&
      isScalar(document.contents) &&
      typeof document.contents.value === "string"
    )
      return document.contents.value;
    throw new TypeError("apktool.yml has an invalid quoted string");
  }
  // Every escape emitted by YamlStringEscapeUtils is also a JSON string
  // escape, including UTF-16 surrogate pairs. Decode once, preserving a
  // doubled backslash followed by literal `u` or `n` as source text.
  const decoded: unknown = JSON.parse(`"${source}"`);
  if (typeof decoded !== "string")
    throw new TypeError("apktool.yml has an invalid Apktool 3 string");
  return decoded;
};

/** Read the package attribute from the decoded Android manifest root. */
export const parseManifestPackage = (manifest: string): string | null => {
  const parsed = parseXmlDocument(manifest, {
    doctype: "allow",
    lineEndings: "preserve",
  });
  if (!parsed.ok)
    throw new TypeError(
      `AndroidManifest.xml is not well-formed XML: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  const root = parsed.value.documentElement;
  if (root === null || root.nodeName !== "manifest")
    throw new TypeError("AndroidManifest.xml root must be <manifest>");
  return root.getAttribute("package") || null;
};

export interface DecodedStringEntry {
  readonly name: string;
  readonly value: string;
}

/** A whole-document failure does not establish an omitted-entry count. */
export class ApktoolStringsDocumentError extends Error {
  readonly _tag = "ApktoolStringsDocumentError";
  constructor(
    readonly reason: "malformed" | "wrong_root",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Project direct `<string>` children from decoded resources XML. DOM parsing
 * identifies elements and attributes; text values are sliced from the input
 * at parser-reported locations so entity spelling and whitespace are kept.
 * Markup-bearing string values are omitted and counted as partial evidence.
 */
export const parseDecodedStrings = (
  stringsXml: string,
): Result<
  {
    readonly entries: readonly DecodedStringEntry[];
    readonly unparsedCount: number;
  },
  ApktoolStringsDocumentError
> => {
  const parsed = parseXmlDocument(stringsXml, {
    doctype: "allow",
    lineEndings: "preserve",
  });
  if (!parsed.ok)
    return err(
      new ApktoolStringsDocumentError("malformed", parsed.error.message, {
        cause: parsed.error,
      }),
    );
  const root = parsed.value.documentElement;
  if (root === null || root.nodeName !== "resources")
    return err(
      new ApktoolStringsDocumentError(
        "wrong_root",
        "String resource document root must be <resources>",
      ),
    );

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
  return ok({ entries, unparsedCount });
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
