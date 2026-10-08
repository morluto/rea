import {
  defaultTreeAdapter,
  parse,
  type DefaultTreeAdapterTypes,
} from "parse5";

interface HtmlScriptReference {
  readonly scriptPath: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

/** Extract inert HTML script references and the first document base href. */
export const htmlArtifactReferences = (
  text: string,
): {
  readonly baseHref: string | null;
  readonly scripts: readonly HtmlScriptReference[];
} => {
  const pending: DefaultTreeAdapterTypes.Node[] = [
    parse(text, { sourceCodeLocationInfo: true }),
  ];
  const scripts: HtmlScriptReference[] = [];
  let baseHref: string | null = null;
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    if (
      defaultTreeAdapter.isElementNode(node) &&
      node.namespaceURI === "http://www.w3.org/1999/xhtml"
    ) {
      if (node.tagName === "base" && baseHref === null) {
        const href = node.attrs.find(({ name }) => name === "href");
        if (href !== undefined) baseHref = href.value;
      }
      if (node.tagName === "script") {
        const src = node.attrs.find(({ name }) => name === "src");
        const location = node.sourceCodeLocation?.startTag;
        if (src !== undefined && src.value !== "" && location !== undefined) {
          scripts.push({
            scriptPath: src.value,
            startOffset: location.startOffset,
            endOffset: location.endOffset,
          });
        }
      }
    }
    // Template content belongs to a separate inert document fragment. Only
    // traverse the actual document children, without recursion on deep input.
    if ("childNodes" in node) {
      for (const child of node.childNodes.toReversed()) pending.push(child);
    }
  }
  return { baseHref, scripts };
};
