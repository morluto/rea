import { DOMParser, onErrorStopParsing, type Document } from "@xmldom/xmldom";
import { SaxesParser } from "saxes";
import { err, ok, type Result } from "./result.js";

/** XML 1.0 literal line endings; Unicode separators remain source characters. */
export const XML_LINE_ENDING = /\r\n?|\n/gu;

export class XmlDocumentParseError extends Error {
  readonly _tag = "XmlDocumentParseError";
  constructor(
    readonly reason: "malformed" | "doctype" | "resource",
    cause?: unknown,
  ) {
    super(
      reason === "resource"
        ? "XML document exceeds its projection node allowance"
        : reason === "doctype"
          ? "XML document types are unsupported"
          : `XML is not well-formed${cause instanceof Error ? `: ${cause.message}` : ""}`,
      { cause },
    );
  }
}

/** A streaming admission limit reached before allocating the DOM. */
export class XmlDocumentNodeLimitError extends XmlDocumentParseError {
  constructor(
    readonly nodes: number,
    readonly maxNodes: number,
  ) {
    super("resource");
  }
}

/** Read XML syntax as a stream, throwing at the first error; it holds only the open elements. */
const checkXmlSyntax = (
  source: string,
  doctype: "allow" | "reject",
  maxNodes?: number,
): void => {
  const syntax = new SaxesParser({
    xmlns: true,
    defaultXMLVersion: "1.0",
    forceXMLVersion: true,
  });
  syntax.on("doctype", () => {
    if (doctype === "reject") throw new XmlDocumentParseError("doctype");
  });
  if (maxNodes !== undefined) {
    let nodes = 0;
    const count = () => {
      nodes += 1;
      if (nodes > maxNodes)
        throw new XmlDocumentNodeLimitError(nodes, maxNodes);
    };
    syntax.on("opentagstart", count);
    syntax.on("attribute", count);
    syntax.on("text", count);
    syntax.on("cdata", count);
    syntax.on("comment", count);
    syntax.on("processinginstruction", count);
  }
  syntax.write(source).close();
};

/** Whether XML passes the syntax check `parseXmlDocument` makes, without building a document. */
export const isWellFormedXml = (
  source: string,
  policy: { readonly doctype: "allow" | "reject" },
): boolean => {
  try {
    checkXmlSyntax(source, policy.doctype);
    return true;
  } catch {
    return false;
  }
};

/** One boundary owns strict XML syntax and the source-located DOM projection. */
export const parseXmlDocument = (
  source: string,
  policy: {
    readonly doctype: "allow" | "reject";
    readonly lineEndings: "preserve" | "normalize";
    readonly maxNodes?: number;
  },
): Result<Document, XmlDocumentParseError> => {
  try {
    checkXmlSyntax(source, policy.doctype, policy.maxNodes);
    // Saxes owns well-formedness outside DTDs. The DOM parser additionally
    // checks DTD syntax and builds source-located nodes; its advisory warnings
    // (including literal U+FFFD) are not byte-decoding or syntax failures.
    return ok(
      new DOMParser({
        normalizeLineEndings:
          policy.lineEndings === "preserve"
            ? (text) => text
            : (text) => text.replace(XML_LINE_ENDING, "\n"),
        onError: onErrorStopParsing,
      }).parseFromString(source, "application/xml"),
    );
  } catch (cause: unknown) {
    return err(
      cause instanceof XmlDocumentParseError
        ? cause
        : new XmlDocumentParseError("malformed", cause),
    );
  }
};
