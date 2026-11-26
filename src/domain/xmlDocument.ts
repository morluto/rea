import {
  DOMParser,
  onErrorStopParsing,
  type Document,
  type Element,
  type Node,
} from "@xmldom/xmldom";
import { SaxesParser, type SaxesTagNS } from "saxes";
import { err, ok, type Result } from "./result.js";
import {
  malformedInput,
  ParseFailureError,
  unsupportedInput,
} from "./parseFailure.js";

/** XML 1.0 literal line endings; Unicode separators remain source characters. */
export const XML_LINE_ENDING = /\r\n?|\n/gu;

/** Match an XML element node regardless of namespace. */
export const isXmlElement = (node: Node | null): node is Element =>
  node !== null && node.nodeType === 1;

/** Match an element in no namespace, including under an explicit empty default. */
export const isUnqualifiedXmlElement = (node: Node | null): node is Element =>
  isXmlElement(node) && node.namespaceURI === null;

/** Direct child elements in document order. An empty namespace selects unqualified elements. */
export function* iterateXmlChildElements(
  element: Element,
  local?: string,
  namespace?: string,
): Generator<Element, undefined> {
  for (
    let child = element.firstChild;
    child !== null;
    child = child.nextSibling
  ) {
    if (
      isXmlElement(child) &&
      (local === undefined || child.localName === local) &&
      (namespace === undefined || (child.namespaceURI ?? "") === namespace)
    )
      yield child;
  }
}

export const xmlChildElements = (element: Element): Element[] => [
  ...iterateXmlChildElements(element),
];

export const xmlChildrenNamed = (
  element: Element,
  local: string,
  namespace?: string,
): Element[] => [...iterateXmlChildElements(element, local, namespace)];

export const xmlFirstChildNamed = (
  element: Element,
  local: string,
  namespace?: string,
): Element | undefined =>
  iterateXmlChildElements(element, local, namespace).next().value;

const XML_FORMAT = "xml";

/** How XML failed: ill-formed syntax, or a DOCTYPE the policy refuses. */
export type XmlParseFailure =
  | ParseFailureError<"malformed">
  | ParseFailureError<"unsupported">;

const notWellFormed = (cause?: unknown): ParseFailureError<"malformed"> =>
  malformedInput(
    XML_FORMAT,
    `XML is not well-formed${cause instanceof Error ? `: ${cause.message}` : ""}`,
    { cause },
  );

/** A DOCTYPE, or its internal subset, that the document policy refuses. */
const unsupportedDoctype = (
  field: "doctype" | "internal-subset",
): ParseFailureError<"unsupported"> =>
  unsupportedInput(
    XML_FORMAT,
    field === "doctype"
      ? "XML document types are unsupported"
      : "XML document type internal subsets are unsupported",
    { field },
  );

/** A failure the syntax check threw itself. */
const isXmlFailure = (cause: unknown): cause is XmlParseFailure =>
  cause instanceof ParseFailureError &&
  cause.failure.format === XML_FORMAT &&
  (cause.kind === "malformed" || cause.kind === "unsupported");

/** The failure the syntax check established; any other throw is ill-formed XML. */
const xmlFailure = (cause: unknown): XmlParseFailure =>
  isXmlFailure(cause) ? cause : notWellFormed(cause);

/** Whether a DOCTYPE's text, as saxes reports it, opens an internal subset: a `[` outside its quoted literals. */
const declaresInternalSubset = (declaration: string): boolean =>
  declaration.replace(/"[^"]*"|'[^']*'/gu, "").includes("[");

/** XML 1.0's `NameStartChar`, and the further characters `NameChar` allows. */
const NAME_START = String.raw`:A-Z_a-z\u{C0}-\u{D6}\u{D8}-\u{F6}\u{F8}-\u{2FF}\u{370}-\u{37D}\u{37F}-\u{1FFF}\u{200C}\u{200D}\u{2070}-\u{218F}\u{2C00}-\u{2FEF}\u{3001}-\u{D7FF}\u{F900}-\u{FDCF}\u{FDF0}-\u{FFFD}\u{10000}-\u{EFFFF}`;
const NAME_MORE = String.raw`\-.0-9\u{B7}\u{300}-\u{36F}\u{203F}\u{2040}`;
/** XML element opening grammar shared by the desktop format readers. */
export const XML_ELEMENT_OPENING = String.raw`<[${NAME_START}][${NAME_START}${NAME_MORE}]*(?=[ \t\r\n]|/?>)`;
const XML_OPENING = new RegExp(
  `^(?:<\\?xml\\b|<!DOCTYPE\\b|${XML_ELEMENT_OPENING})`,
  "u",
);

/** Whether text begins with a possible XML declaration, DOCTYPE or start tag. */
export const opensLikeXml = (source: string): boolean =>
  XML_OPENING.test(source);

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
  nameSupported?: (name: string) => boolean,
): void => {
  const syntax = new SaxesParser({
    xmlns: true,
    defaultXMLVersion: "1.0",
    forceXMLVersion: true,
  });
  listen?.(syntax);
  const checkName = (name: string) => {
    if (nameSupported !== undefined && !nameSupported(name))
      throw notWellFormed();
  };
  if (nameSupported !== undefined) {
    syntax.on("opentagstart", (tag) => checkName(tag.name));
    syntax.on("attribute", (attribute) => checkName(attribute.name));
    syntax.on("processinginstruction", (instruction) =>
      checkName(instruction.target),
    );
  }
  if (doctype !== "allow")
    syntax.on("doctype", (declaration) => {
      if (doctype === "reject") throw unsupportedDoctype("doctype");
      if (declaresInternalSubset(declaration))
        throw unsupportedDoctype("internal-subset");
      if (!EXTERNAL_DOCTYPE.test(declaration)) throw notWellFormed();
      checkName(declaration.trimStart().split(/[ \t\r\n]/u, 1)[0] ?? "");
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
  policy: {
    readonly doctype: Exclude<DoctypePolicy, "allow">;
    readonly nameSupported?: (name: string) => boolean;
  },
): boolean => {
  try {
    checkXmlSyntax(source, policy.doctype, undefined, policy.nameSupported);
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
  XmlParseFailure
> => {
  const ranges: { start: number; end: number }[] = [];
  // Each open element's start, and whether it was picked.
  const open: { start: number; picked: boolean }[] = [];
  let selectedAncestor = false;
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
        if (element === undefined || selectedAncestor) return;
        element.picked = select({
          uri: tag.uri,
          local: tag.local,
          attribute: (uri, local) =>
            Object.values(tag.attributes).find(
              (attribute) => attribute.uri === uri && attribute.local === local,
            )?.value,
        });
        selectedAncestor = element.picked;
      });
      syntax.on("closetag", () => {
        const element = open.pop();
        if (element?.picked === true) {
          ranges.push({ start: element.start, end: syntax.position });
          selectedAncestor = false;
        }
      });
    });
    return ok(ranges.sort((left, right) => left.start - right.start));
  } catch (cause: unknown) {
    return err(xmlFailure(cause));
  }
};

/** Inclusive source ranges of attribute quotes, parsed without reading a DTD. */
export const xmlAttributeQuoteRanges = (
  source: string,
): Result<
  readonly { readonly start: number; readonly end: number }[],
  {
    readonly error: XmlParseFailure;
    readonly ranges: readonly {
      readonly start: number;
      readonly end: number;
    }[];
    readonly examined: number;
  }
> => {
  const ranges: { start: number; end: number }[] = [];
  let reader: SaxesParser<{ xmlns: true }> | undefined;
  try {
    checkXmlSyntax(source, "allow", (syntax) => {
      reader = syntax;
      syntax.on("attribute", () => {
        const end = syntax.position - 1;
        const quote = source[end];
        if (quote !== '"' && quote !== "'") throw notWellFormed();
        const start = source.lastIndexOf(quote, end - 1);
        if (start < 0) throw notWellFormed();
        ranges.push({ start, end });
      });
    });
    return ok(ranges);
  } catch (cause: unknown) {
    return err({
      error: xmlFailure(cause),
      ranges,
      examined: Math.max(0, (reader?.position ?? 0) - 1),
    });
  }
};

class StopXmlNodeCount extends Error {}

type XmlLineEndings = "preserve" | "normalize";

interface XmlNodeLimitFailure {
  readonly kind: "node-limit";
  readonly maximum: number;
  readonly required: number;
}

/**
 * Validate an XML document that disallows a DOCTYPE and count its projected
 * nodes in the same stream. Honor the node ceiling before allocating a DOM.
 */
export const parseXmlDocumentWithinNodeLimit = (
  source: string,
  policy: {
    readonly maximumNodes: number;
    readonly lineEndings: XmlLineEndings;
  },
): Result<Document, XmlParseFailure | XmlNodeLimitFailure> => {
  let nodes = 0;
  let doctypeSeen = false;
  let failure: XmlParseFailure | undefined;
  const count = () => {
    nodes += 1;
    if (nodes > policy.maximumNodes) throw new StopXmlNodeCount();
  };
  try {
    checkXmlSyntax(source, "allow", (syntax) => {
      // A counting failure unrelated to XML syntax must keep its own cause.
      syntax.on("error", (cause) => {
        throw notWellFormed(cause);
      });
      syntax.on("doctype", () => {
        // The node ceiling can be reached even after a DOCTYPE was seen.
        doctypeSeen = true;
      });
      syntax.on("opentagstart", count);
      syntax.on("attribute", count);
      syntax.on("text", count);
      syntax.on("cdata", count);
      syntax.on("comment", count);
      syntax.on("processinginstruction", count);
    });
  } catch (cause: unknown) {
    if (cause instanceof StopXmlNodeCount)
      return err({
        kind: "node-limit",
        maximum: policy.maximumNodes,
        required: nodes,
      });
    if (!isXmlFailure(cause)) throw cause;
    failure = cause;
  }
  if (doctypeSeen) return err(unsupportedDoctype("doctype"));
  return failure === undefined
    ? buildXmlDocument(source, policy.lineEndings)
    : err(failure);
};

/** One boundary owns strict XML syntax, under a DOCTYPE policy, and the source-located DOM projection. */
export const parseXmlDocument = (
  source: string,
  policy: {
    readonly doctype: DoctypePolicy;
    readonly lineEndings: XmlLineEndings;
    readonly nameSupported?: (name: string) => boolean;
  },
): Result<Document, XmlParseFailure> => {
  try {
    checkXmlSyntax(source, policy.doctype, undefined, policy.nameSupported);
  } catch (cause: unknown) {
    return err(xmlFailure(cause));
  }
  return buildXmlDocument(source, policy.lineEndings);
};

const buildXmlDocument = (
  source: string,
  lineEndings: XmlLineEndings,
): Result<Document, XmlParseFailure> => {
  try {
    // Saxes owns well-formedness outside DTDs. The DOM parser additionally
    // checks DTD syntax and builds source-located nodes; its advisory warnings
    // (including literal U+FFFD) are not byte-decoding or syntax failures.
    return ok(
      new DOMParser({
        normalizeLineEndings:
          lineEndings === "preserve"
            ? (text) => text
            : (text) => text.replace(XML_LINE_ENDING, "\n"),
        onError: onErrorStopParsing,
      }).parseFromString(source, "application/xml"),
    );
  } catch (cause: unknown) {
    return err(xmlFailure(cause));
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
