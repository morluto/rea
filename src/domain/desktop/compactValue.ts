import type { JsonValue } from "../jsonValue.js";
import { isXmlElement } from "./viewPointer.js";

const isRecord = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** An element's attributes; none for a value that holds none. */
export const attributesOf = (element: Record<string, JsonValue>) => {
  const { attributes } = element;
  return isRecord(attributes) ? attributes : {};
};

/** Keep one character past the limit to distinguish an exact fit from a cut. */
export const previewWriter = (max: number) => {
  const parts: string[] = [];
  let length = 0;
  const push = (text: string): boolean => {
    const kept = text.slice(0, Math.max(0, max + 1 - length));
    parts.push(kept);
    length += kept.length;
    return length <= max;
  };
  const escaped = (text: string, attribute = false): boolean => {
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index] ?? "";
      if (
        !push(
          char === "&"
            ? "&amp;"
            : char === "<"
              ? "&lt;"
              : attribute && char === '"'
                ? "&quot;"
                : char,
        )
      )
        return false;
    }
    return true;
  };
  const jsonString = (text: string): boolean => {
    if (!push('"')) return false;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.codePointAt(index);
      const width = code !== undefined && code > 0xffff ? 2 : 1;
      const encoded = JSON.stringify(text.slice(index, index + width));
      if (!push(encoded.slice(1, -1))) return false;
      index += width - 1;
    }
    return push('"');
  };
  const startTag = (
    element: Record<string, JsonValue> & { name: string },
  ): boolean => {
    if (!push("<") || !push(element.name)) return false;
    const attributes = attributesOf(element);
    for (const key in attributes) {
      if (!Object.hasOwn(attributes, key)) continue;
      if (
        !push(" ") ||
        !push(key) ||
        !push('="') ||
        !escaped(String(attributes[key]), true) ||
        !push('"')
      )
        return false;
    }
    return true;
  };
  return {
    push,
    escaped,
    jsonString,
    startTag,
    result: () => cut(parts.join(""), max),
  };
};

/** An archive entry's own fields, without its view. */
const isArchiveEntry = (value: JsonValue): value is Record<string, JsonValue> =>
  isRecord(value) && "sha256" in value && "view" in value && "name" in value;

/**
 * A value as an author reads it: a scalar as it is, cut past `max`
 * characters; an element as compact XML, with every text node the XML reader
 * kept, which already leaves out the whitespace an app lays out between
 * elements; an archive entry as its name, format and size; anything else as
 * JSON. Writing stops once past `max`, so a large subtree costs no more than
 * the cut.
 */
export const compactValue = (
  value: JsonValue | undefined,
  max: number,
  format: "json" | "xml" | "archive",
): JsonValue => {
  if (value === undefined) return null;
  if (typeof value === "string") return cut(value, max);
  if (value === null || typeof value !== "object") return value;
  const { push, escaped, jsonString, startTag, result } = previewWriter(max);
  const write = (node: JsonValue): boolean => {
    if (format === "xml" && isXmlElement(node)) {
      if (!startTag(node)) return false;
      if (node.children.length === 0) return push("/>");
      return (
        push(">") &&
        node.children.every((child) =>
          typeof child === "string" ? escaped(child) : write(child),
        ) &&
        push("</") &&
        push(node.name) &&
        push(">")
      );
    }
    if (format === "archive" && isArchiveEntry(node))
      return write({
        ...(node.name === undefined ? {} : { name: node.name }),
        format: node.format ?? null,
        size: node.size ?? null,
      });
    if (Array.isArray(node))
      return (
        push("[") &&
        node.every(
          (item, index) => (index === 0 || push(",")) && write(item),
        ) &&
        push("]")
      );
    if (isRecord(node)) {
      if (!push("{")) return false;
      let first = true;
      for (const key in node) {
        if (!Object.hasOwn(node, key)) continue;
        if (
          (!first && !push(",")) ||
          !jsonString(key) ||
          !push(":") ||
          !write(node[key] ?? null)
        )
          return false;
        first = false;
      }
      return push("}");
    }
    return typeof node === "string"
      ? jsonString(node)
      : push(JSON.stringify(node));
  };
  write(value);
  return result();
};
