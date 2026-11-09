import { DOMParser, onErrorStopParsing, type Document } from "@xmldom/xmldom";
import { SaxesParser, type SaxesTagNS } from "saxes";
import { err, ok, type Result } from "./result.js";

/** XML 1.0 literal line endings; Unicode separators remain source characters. */
export const XML_LINE_ENDING = /\r\n?|\n/gu;

export class XmlDocumentParseError extends Error {
  readonly _tag = "XmlDocumentParseError";
  constructor(
    readonly reason: "malformed" | "doctype" | "internal-subset",
    cause?: unknown,
  ) {
    super(
      reason === "doctype"
        ? "XML document types are unsupported"
        : reason === "internal-subset"
          ? "XML document type internal subsets are unsupported"
          : `XML is not well-formed${cause instanceof Error ? `: ${cause.message}` : ""}`,
      { cause },
    );
  }
}

/** Whether a DOCTYPE's text, as saxes reports it, opens an internal subset: a `[` outside its quoted literals. */
const declaresInternalSubset = (declaration: string): boolean =>
  declaration.replace(/"[^"]*"|'[^']*'/gu, "").includes("[");

/** XML 1.0's `NameStartChar`, and the further characters `NameChar` allows. */
const NAME_START = String.raw`:A-Z_a-z\u{C0}-\u{D6}\u{D8}-\u{F6}\u{F8}-\u{2FF}\u{370}-\u{37D}\u{37F}-\u{1FFF}\u{200C}\u{200D}\u{2070}-\u{218F}\u{2C00}-\u{2FEF}\u{3001}-\u{D7FF}\u{F900}-\u{FDCF}\u{FDF0}-\u{FFFD}\u{10000}-\u{EFFFF}`;
const NAME_MORE = String.raw`\-.0-9\u{B7}\u{300}-\u{36F}\u{203F}\u{2040}`;
/** XML 1.0's `PubidChar` but the apostrophe, which only a double-quoted literal may hold. */
const PUBID = String.raw`\n\r a-zA-Z0-9\-()+,./:=?;!*#@$_%`;
const SPACE = String.raw`[ \t\r\n]`;

/**
 * A DOCTYPE without an internal subset, as XML 1.0's `doctypedecl` spells it
 * between `<!DOCTYPE` and `>`: a name, then optionally `SYSTEM` and a literal,
 * or `PUBLIC` and a public identifier and a literal.
 */
const EXTERNAL_DOCTYPE = new RegExp(
  `^${SPACE}+[${NAME_START}][${NAME_START}${NAME_MORE}]*` +
    `(?:${SPACE}+(?:SYSTEM|PUBLIC${SPACE}+(?:"[${PUBID}']*"|'[${PUBID}]*'))` +
    `${SPACE}+(?:"[^"]*"|'[^']*'))?${SPACE}*$`,
  "u",
);

/**
 * Which DOCTYPE a document may have: any, none, or with `external` one
 * without an internal subset, so the document declares no entity. Neither
 * parser reads an external DTD.
 */
type DoctypePolicy = "allow" | "reject" | "external";

/**
 * Read XML syntax as a stream, throwing at the first error; it holds only the
 * open elements. Saxes reads a DOCTYPE without checking it, so the policy
 * checks one it admits without an internal subset against XML's grammar.
 */
const checkXmlSyntax = (
  source: string,
  doctype: DoctypePolicy,
  listen?: (syntax: SaxesParser<{ xmlns: true }>) => void,
): void => {
  const syntax = new SaxesParser({
    xmlns: true,
    defaultXMLVersion: "1.0",
    forceXMLVersion: true,
  });
  listen?.(syntax);
  syntax.on("doctype", (declaration) => {
    if (doctype === "reject") throw new XmlDocumentParseError("doctype");
    if (doctype !== "external") return;
    if (declaresInternalSubset(declaration))
      throw new XmlDocumentParseError("internal-subset");
    if (!EXTERNAL_DOCTYPE.test(declaration))
      throw new XmlDocumentParseError("malformed");
  });
  syntax.write(source).close();
};

/**
 * Whether XML passes the syntax check `parseXmlDocument` makes, without
 * building a document. An internal subset's syntax needs the DOM parser, so
 * the policy must refuse one.
 */
export const isWellFormedXml = (
  source: string,
  policy: { readonly doctype: Exclude<DoctypePolicy, "allow"> },
): boolean => {
  try {
    checkXmlSyntax(source, policy.doctype);
    return true;
  } catch {
    return false;
  }
};

/** An element as `xmlElementRanges` offers it: its namespace and local name, and an attribute's value by namespace and local name. */
export interface XmlElementFacts {
  readonly uri: string;
  readonly local: string;
  readonly attribute: (uri: string, local: string) => string | undefined;
}

/**
 * The source ranges of the elements `select` picks, from the `<` of the start
 * tag to the `>` that ends the element, outermost first and none inside
 * another picked one; read with the syntax check `parseXmlDocument` makes, so
 * text in a comment, CDATA or an attribute is never an element.
 */
export const xmlElementRanges = (
  source: string,
  select: (element: XmlElementFacts) => boolean,
  policy: { readonly doctype: Exclude<DoctypePolicy, "allow"> },
): Result<
  readonly { readonly start: number; readonly end: number }[],
  XmlDocumentParseError
> => {
  const ranges: { start: number; end: number }[] = [];
  // Each open element's start, and whether it was picked.
  const open: { start: number; picked: boolean }[] = [];
  try {
    checkXmlSyntax(source, policy.doctype, (syntax) => {
      // Saxes reports the opening after reading the name and one character past it, none of which is `<`.
      syntax.on("opentagstart", () => {
        open.push({
          start: source.lastIndexOf("<", syntax.position - 1),
          picked: false,
        });
      });
      syntax.on("opentag", (tag: SaxesTagNS) => {
        const element = open.at(-1);
        if (element === undefined || open.some(({ picked }) => picked)) return;
        element.picked = select({
          uri: tag.uri,
          local: tag.local,
          attribute: (uri, local) =>
            Object.values(tag.attributes).find(
              (attribute) => attribute.uri === uri && attribute.local === local,
            )?.value,
        });
      });
      syntax.on("closetag", () => {
        const element = open.pop();
        if (element?.picked === true)
          ranges.push({ start: element.start, end: syntax.position });
      });
    });
    return ok(ranges.sort((left, right) => left.start - right.start));
  } catch (cause: unknown) {
    return err(
      cause instanceof XmlDocumentParseError
        ? cause
        : new XmlDocumentParseError("malformed", cause),
    );
  }
};

/** One boundary owns strict XML syntax, under a DOCTYPE policy, and the source-located DOM projection. */
export const parseXmlDocument = (
  source: string,
  policy: {
    readonly doctype: DoctypePolicy;
    readonly lineEndings: "preserve" | "normalize";
  },
): Result<Document, XmlDocumentParseError> => {
  try {
    checkXmlSyntax(source, policy.doctype);
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

/** A DOCTYPE's name and external identifiers, null where it gives none. */
export interface DeclaredDocumentType {
  readonly name: string;
  readonly publicId: string | null;
  readonly systemId: string | null;
}

/** A quoted literal's value; the DOM keeps the quotes, and holds "" where there is no literal. */
const literalValue = (literal: string): string | null =>
  literal === "" ? null : literal.slice(1, -1);

/**
 * The document's DOCTYPE as declared, or undefined without one. The public
 * identifier is normalized as XML matches it, and as expat reports it: each
 * run of spaces and line breaks becomes one space, and the ends are trimmed.
 */
export const declaredDocumentType = (
  document: Document,
): DeclaredDocumentType | undefined => {
  const doctype = document.doctype;
  if (doctype === null) return undefined;
  const publicId = literalValue(doctype.publicId);
  return {
    name: doctype.name,
    publicId:
      publicId === null
        ? null
        : publicId.replace(/[ \r\n]+/gu, " ").replace(/^ | $/gu, ""),
    systemId: literalValue(doctype.systemId),
  };
};
