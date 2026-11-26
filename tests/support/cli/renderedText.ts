import type { DefaultTreeAdapterTypes } from "parse5";

export const renderedText = (node: DefaultTreeAdapterTypes.Node): string =>
  node.nodeName === "#text" && "value" in node
    ? node.value
    : "childNodes" in node
      ? node.childNodes.map(renderedText).join("")
      : "";
