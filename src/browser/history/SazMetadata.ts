import { DOMParser, ParseError, type Node } from "@xmldom/xmldom";
import type { JsonValue } from "../../domain/jsonValue.js";
import { WEB_NETWORK_CAPTURE_LIMITS } from "../../domain/webNetworkCapture.js";
import { CaptureFormatError } from "./CaptureFormatError.js";

/** Preserve XML node order, attribute names and text without interpreting producer-specific flags. */
export const decodeSazMetadata = (bytes: Buffer): JsonValue => {
  let xml: string;
  try {
    const encoding =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? "utf-16le"
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? "utf-16be"
          : "utf-8";
    xml = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new CaptureFormatError(
      "unsupported",
      "SAZ metadata must use UTF-8 or BOM-marked UTF-16.",
    );
  }
  let parseFailed = false;
  let document: ReturnType<DOMParser["parseFromString"]>;
  try {
    document = new DOMParser({
      normalizeLineEndings: (source) => source,
      onError: () => {
        parseFailed = true;
      },
    }).parseFromString(xml, "application/xml");
  } catch (cause: unknown) {
    if (!(cause instanceof ParseError)) throw cause;
    throw new CaptureFormatError(
      "format",
      "SAZ metadata is not well-formed XML.",
    );
  }
  // The pinned parser does not resolve external or DTD-defined entities.
  // Inspect its parsed node; text inside comments/CDATA is ordinary evidence.
  if (document.doctype !== null)
    throw new CaptureFormatError(
      "unsupported",
      "SAZ metadata DTDs are unsupported.",
    );
  if (parseFailed)
    throw new CaptureFormatError(
      "format",
      "SAZ metadata is not well-formed XML.",
    );
  if (document.documentElement?.tagName !== "Session")
    throw new CaptureFormatError(
      "format",
      "SAZ metadata must have a Session document element.",
    );
  const visit = (node: Node, depth: number): JsonValue => {
    if (depth > WEB_NETWORK_CAPTURE_LIMITS.depth)
      throw new CaptureFormatError(
        "input-limit",
        "SAZ metadata exceeds the complete-evidence nesting budget.",
      );
    const children: JsonValue[] = [];
    for (let child = node.firstChild; child !== null; child = child.nextSibling)
      children.push(visit(child, depth + 1));
    const attributes: JsonValue[] = [];
    if (node.nodeType === 1) {
      const element = node as import("@xmldom/xmldom").Element;
      for (let i = 0; i < element.attributes.length; i++) {
        const attribute = element.attributes.item(i);
        if (attribute !== null)
          attributes.push({ name: attribute.name, value: attribute.value });
      }
    }
    return {
      name: node.nodeName,
      type: node.nodeType,
      value: node.nodeValue,
      attributes,
      children,
    };
  };
  return visit(document, 0);
};
