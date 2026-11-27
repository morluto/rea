import type { Element, Node } from "@xmldom/xmldom";

const ELEMENT_NODE = 1;

export const isXmlElement = (node: Node | null): node is Element =>
  node !== null && node.nodeType === ELEMENT_NODE;

/** Direct child elements with `tagName`, in document order. */
export const childElements = (
  element: Element,
  tagName?: string,
): Element[] => {
  const children: Element[] = [];
  for (const node of Array.from(element.childNodes)) {
    if (!isXmlElement(node)) continue;
    if (tagName !== undefined && node.tagName !== tagName) continue;
    children.push(node);
  }
  return children;
};

export const childElement = (
  element: Element,
  tagName: string,
): Element | undefined => childElements(element, tagName)[0];

export const childText = (
  element: Element,
  tagName: string,
): string | undefined => {
  const child = childElement(element, tagName);
  if (child === undefined) return undefined;
  const text = child.textContent;
  return text === null ? undefined : text;
};

export const attributeOf = (element: Element, name: string): string | null => {
  const value = element.getAttribute(name);
  return value === "" ? null : value;
};
