import type { JsonValue } from "../jsonValue.js";
import { isXmlElement } from "./viewPointer.js";

const isRecord = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

export const escapeText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const escapeAttribute = (text: string) =>
  escapeText(text).replaceAll('"', "&quot;");

/** An element's attributes; none for a value that holds none. */
export const attributesOf = (element: Record<string, JsonValue>) => {
  const { attributes } = element;
  return isRecord(attributes) ? attributes : {};
};

/** An element's start tag with its attributes. */
export const startTag = (
  element: Record<string, JsonValue> & { name: string },
) =>
  `<${element.name}${Object.entries(attributesOf(element))
    .map(([key, value]) => ` ${key}="${escapeAttribute(String(value))}"`)
    .join("")}`;

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
): JsonValue => {
  if (value === undefined) return null;
  if (typeof value === "string") return cut(value, max);
  if (value === null || typeof value !== "object") return value;
  const parts: string[] = [];
  let length = 0;
  const push = (text: string) => {
    parts.push(text);
    length += text.length;
    return length <= max;
  };
  const write = (node: JsonValue): boolean => {
    if (isXmlElement(node)) {
      const start = startTag(node);
      if (node.children.length === 0) return push(`${start}/>`);
      return (
        push(`${start}>`) &&
        node.children.every((child) =>
          typeof child === "string" ? push(escapeText(child)) : write(child),
        ) &&
        push(`</${node.name}>`)
      );
    }
    if (isArchiveEntry(node))
      return push(
        JSON.stringify({
          name: node.name,
          format: node.format ?? null,
          size: node.size ?? null,
        }),
      );
    if (Array.isArray(node))
      return (
        push("[") &&
        node.every(
          (item, index) => (index === 0 || push(",")) && write(item),
        ) &&
        push("]")
      );
    if (isRecord(node))
      return (
        push("{") &&
        Object.entries(node).every(
          ([key, item], index) =>
            (index === 0 || push(",")) &&
            push(`${JSON.stringify(key)}:`) &&
            write(item),
        ) &&
        push("}")
      );
    return push(JSON.stringify(node));
  };
  write(value);
  return cut(parts.join(""), max);
};
