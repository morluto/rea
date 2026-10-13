import { numberValue, recordValue } from "./CdpCaptureValues.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

interface DomSnapshotNodes {
  readonly nodeTypes: readonly number[];
  readonly nodeNames: readonly number[];
  readonly parents: readonly number[];
  readonly strings: readonly string[];
  readonly attributes: readonly unknown[];
}

interface XmlSvgLink {
  readonly svgElement: boolean;
  readonly xlinkHref: string | undefined;
}

interface DocumentSvgAncestry {
  readonly xml: boolean;
  readonly xmlLinks: Map<number, XmlSvgLink>;
}

export interface DomSvgNodeQuery {
  readonly backendNodeId: number;
  readonly nodeName: string;
}

/** Bind the browser's SVG flag to the exact snapshotted element. */
export const capturedSvgNodeKind = (
  query: DomSvgNodeQuery,
  result: unknown,
): boolean | undefined => {
  const node = recordValue(recordValue(result)?.node);
  if (
    node?.backendNodeId !== query.backendNodeId ||
    node.nodeName !== query.nodeName ||
    node.nodeType !== 1
  )
    return undefined;
  // CDP omits isSVG for non-SVG nodes. Other values are malformed, not false.
  return node.isSVG === undefined
    ? false
    : typeof node.isSVG === "boolean"
      ? node.isSVG
      : undefined;
};

interface DomSvgLink {
  readonly svgElement: boolean;
  readonly xmlDocument: boolean;
  readonly xlinkHref: string | undefined;
}

const UNRESOLVED: XmlSvgLink = {
  svgElement: false,
  xlinkHref: undefined,
};

const stringAt = (strings: readonly string[], index: unknown): string => {
  const integer = numberValue(index);
  return integer === undefined ? "" : (strings[Math.trunc(integer)] ?? "");
};

const numberArray = (value: unknown): readonly number[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const number = numberValue(item);
        return number === undefined ? [] : [number];
      })
    : [];

// DOMSnapshot has no namespace URI. HTML documents use uppercase `HTML` and
// the parser's local names. XML documents preserve prefixed names and xmlns
// declarations, including those on standalone SVG roots.
const xmlDocument = (nodes: DomSnapshotNodes): boolean => {
  const documentIndex = nodes.nodeTypes.findIndex(
    (nodeType) => Math.trunc(nodeType) === 9,
  );
  if (documentIndex < 0) return false;
  for (let index = 0; index < nodes.nodeTypes.length; index += 1) {
    if (Math.trunc(nodes.nodeTypes[index] ?? 0) !== 1) continue;
    if (Math.trunc(nodes.parents[index] ?? -1) !== documentIndex) continue;
    const name = stringAt(nodes.strings, nodes.nodeNames[index]);
    if (name === "HTML") return false;
    if (name === "html" || name.includes(":")) return true;
    // Explicit namespaces also identify standalone SVG and other XML roots.
    // Namespace-free synthetic snapshots retain the legacy HTML behavior.
    const attributes = numberArray(nodes.attributes[index]);
    return attributes.some(
      (value, offset) =>
        offset % 2 === 0 &&
        xmlnsPrefix(stringAt(nodes.strings, value)) !== undefined,
    );
  }
  return false;
};

export const createDocumentSvgAncestry = (
  nodes: DomSnapshotNodes,
): DocumentSvgAncestry => {
  const xml = xmlDocument(nodes);
  return {
    xml,
    xmlLinks: xml ? resolveXmlElements(nodes) : new Map(),
  };
};

export const domSvgLink = (
  ancestry: DocumentSvgAncestry,
  index: number,
): DomSvgLink => {
  if (!ancestry.xml) {
    return {
      svgElement: false,
      xmlDocument: false,
      xlinkHref: undefined,
    };
  }
  const resolved = ancestry.xmlLinks.get(index) ?? UNRESOLVED;
  return {
    svgElement: resolved.svgElement,
    xmlDocument: true,
    xlinkHref: resolved.xlinkHref,
  };
};

interface NamespaceRestore {
  readonly prefix: string;
  readonly previous: string | undefined;
}

type XmlWalkStep =
  | { readonly node: number }
  | { readonly restore: readonly NamespaceRestore[] };

// Walk parent-before-child with one mutable namespace environment. Restore
// declarations on exit so siblings retain their own scope. Only declarations
// on the active path are retained, rather than cumulative maps at every node.
const resolveXmlElements = (
  nodes: DomSnapshotNodes,
): Map<number, XmlSvgLink> => {
  const children = new Map<number, number[]>();
  const pending: XmlWalkStep[] = [];
  for (let node = 0; node < nodes.nodeNames.length; node += 1) {
    const parent = Math.trunc(nodes.parents[node] ?? -1);
    if (parent < 0) pending.push({ node });
    else if (parent < nodes.nodeNames.length && parent !== node) {
      const siblings = children.get(parent);
      if (siblings === undefined) children.set(parent, [node]);
      else siblings.push(node);
    }
  }
  const bindings = new Map<string, string>();
  const resolved = new Map<number, XmlSvgLink>();
  while (pending.length > 0) {
    const step = pending.pop();
    if (step === undefined) break;
    if ("restore" in step) {
      for (const { prefix, previous } of step.restore) {
        if (previous === undefined) bindings.delete(prefix);
        else bindings.set(prefix, previous);
      }
      continue;
    }
    const { node } = step;
    const attributes = numberArray(nodes.attributes[node]);
    const restore = applyDeclarations(bindings, attributes, nodes.strings);
    const svgElement =
      Math.trunc(nodes.nodeTypes[node] ?? 0) === 1 &&
      elementNamespace(
        stringAt(nodes.strings, nodes.nodeNames[node]),
        bindings,
      ) === SVG_NAMESPACE;
    resolved.set(node, {
      svgElement,
      xlinkHref: svgElement
        ? xlinkHrefValue(attributes, nodes.strings, bindings)
        : undefined,
    });
    pending.push({ restore });
    for (const child of children.get(node) ?? []) pending.push({ node: child });
  }
  // Cycles (including self-parents) and dangling chains cannot reach a root,
  // so remain unresolved instead of deriving URLs from an invalid ancestry.
  return resolved;
};

const applyDeclarations = (
  bindings: Map<string, string>,
  attributes: readonly number[],
  strings: readonly string[],
): readonly NamespaceRestore[] => {
  const restore: NamespaceRestore[] = [];
  const seen = new Set<string>();
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    const prefix = xmlnsPrefix(stringAt(strings, attributes[index]));
    if (prefix === undefined || seen.has(prefix)) continue;
    seen.add(prefix);
    restore.push({ prefix, previous: bindings.get(prefix) });
    const value = stringAt(strings, attributes[index + 1]);
    if (value.length === 0) bindings.delete(prefix);
    else bindings.set(prefix, value);
  }
  return restore;
};

const xmlnsPrefix = (name: string): string | undefined => {
  if (name === "xmlns") return "";
  if (!name.startsWith("xmlns:")) return undefined;
  const prefix = name.slice("xmlns:".length);
  if (prefix.length === 0 || prefix === "xmlns" || prefix.includes(":"))
    return undefined;
  return prefix;
};

const elementNamespace = (
  nodeName: string,
  bindings: ReadonlyMap<string, string>,
): string => {
  const colon = nodeName.indexOf(":");
  if (colon < 0) return bindings.get("") ?? "";
  const prefix = nodeName.slice(0, colon);
  const local = nodeName.slice(colon + 1);
  if (
    prefix.length === 0 ||
    local.length === 0 ||
    local.includes(":") ||
    prefix === "xmlns"
  )
    return "";
  return bindings.get(prefix) ?? "";
};

// First prefixed href bound to the XLink namespace. Duplicate names keep the
// earlier value. Plain href is applied by the caller and wins even when empty.
const xlinkHrefValue = (
  attributes: readonly number[],
  strings: readonly string[],
  bindings: ReadonlyMap<string, string>,
): string | undefined => {
  const seen = new Set<string>();
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    const name = stringAt(strings, attributes[index]);
    if (seen.has(name)) continue;
    seen.add(name);
    const colon = name.indexOf(":");
    if (colon <= 0) continue;
    const prefix = name.slice(0, colon);
    const local = name.slice(colon + 1);
    if (local !== "href" || bindings.get(prefix) !== XLINK_NAMESPACE) continue;
    return stringAt(strings, attributes[index + 1]);
  }
  return undefined;
};
