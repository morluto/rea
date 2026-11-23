import { isUtf8 } from "node:buffer";

import { parseJsonWithDuplicatePolicy } from "../../domain/jsonDuplicateMember.js";
import { sourceMapJsonText } from "../../domain/sourceMapEnvelope.js";
import { inspectSourceMap } from "../../domain/sourceMapFormat.js";
import { byteOrderMarkEncoding } from "../../domain/textByteOrderMark.js";
import { isJavaScriptSourceMapName } from "./memberClassification.js";
import {
  decodeDeclaredText,
  getCachedTextDecoder,
  type MemberText,
} from "./memberTextDecoding.js";

/** Interpretation is separate from the member's source path. */
export interface SourceMapReference {
  readonly location: string;
  readonly kind: "javascript-source-map" | "possible-linker-map";
  readonly genericName?: boolean;
  readonly occurrence?: object;
}

export const namedMapReference = (
  logical: string,
  location: string,
  occurrence?: object,
): SourceMapReference => ({
  location,
  genericName:
    logical.toLowerCase().endsWith(".map") &&
    !isJavaScriptSourceMapName(logical),
  ...(occurrence === undefined ? {} : { occurrence }),
  kind: isJavaScriptSourceMapName(logical)
    ? "javascript-source-map"
    : "possible-linker-map",
});

/**
 * A map's text in the encoding its byte order mark names, or null for one this
 * reader does not decode, which leaves the map unresolved. Unmarked bytes are
 * read as UTF-8, as a source map is.
 */
export const mapText = (bytes: Buffer): MemberText | null => {
  const encoding = byteOrderMarkEncoding(bytes);
  if (encoding === null)
    return { text: bytes.toString("utf8"), complete: isUtf8(bytes) };
  if (encoding === "utf-32") return null;
  return decodeDeclaredText(bytes, encoding);
};

export const mayHaveSourceMapPrefix = (prefix: Buffer): boolean => {
  const encoding = byteOrderMarkEncoding(prefix);
  if (encoding === "utf-32") return true;
  try {
    const text = new TextDecoder(encoding ?? "utf-8", { fatal: true }).decode(
      prefix,
      { stream: true },
    );
    return mayHaveSourceMapText(text);
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause;
    return !hasVisibleNonMapPrefix(
      getCachedTextDecoder(encoding ?? "utf-8", false).decode(prefix),
    );
  }
};

export const mayHaveSourceMapText = (decoded: string): boolean => {
  const text = sourceMapJsonText(decoded).trimStart();
  return text.length === 0 || text.startsWith("{");
};

/** A visible ASCII non-JSON prefix remains evidence even if later text is lossy. */
export const hasVisibleNonMapPrefix = (text: string): boolean => {
  const envelope = text.startsWith(")]}'");
  if (envelope && !/[\r\n]/u.test(text)) return false;
  const first = sourceMapJsonText(text).trimStart().charCodeAt(0);
  // A leading ')' without a complete envelope may still begin one.
  return (
    first >= 0x21 &&
    first <= 0x7e &&
    first !== 0x7b &&
    (envelope || first !== 0x29)
  );
};

export const isSourceMapJsonObject = (text: string): boolean => {
  const decoded = parseJsonWithDuplicatePolicy(
    sourceMapJsonText(text),
    "last-wins",
  );
  if (!decoded.ok) return false;
  const parsed = decoded.value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return false;
  return (
    "version" in parsed &&
    ("mappings" in parsed || "sources" in parsed || "sections" in parsed)
  );
};

export const parsesAsSourceMap = (bytes: Buffer): boolean => {
  const text = mapText(bytes);
  if (text === null || !text.complete) return false;
  try {
    inspectSourceMap(text.text);
    return true;
  } catch {
    return false;
  }
};
