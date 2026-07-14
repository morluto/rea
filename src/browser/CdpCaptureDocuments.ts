import type {
  InspectWebPageInput,
  WebPageInspection,
} from "../domain/browserObservation.js";
import {
  allowedSanitizedUrl,
  boundedText,
  numberValue,
  recordValue,
  recordsValue,
  requiredRecord,
  stringValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";

/** Normalize allowed frames while retaining a bounded prefix and total count. */
export const captureFrames = (
  result: unknown,
  allowedOrigins: ReadonlySet<string>,
  maximum: number,
): {
  readonly total: number;
  readonly items: WebPageInspection["frames"];
} => {
  const root = recordValue(requiredRecord(result).frameTree);
  if (root === undefined) return { total: 0, items: [] };
  const items: WebPageInspection["frames"] = [];
  let total = 0;
  for (const tree of walkFrameTrees(root)) {
    const frame = recordValue(tree.frame);
    const frameId = stringValue(frame?.id);
    const sanitized = allowedSanitizedUrl(frame?.url, allowedOrigins);
    if (
      frame === undefined ||
      frameId === undefined ||
      frameId.length > 256 ||
      sanitized === undefined ||
      sanitized.origin === null
    )
      continue;
    total += 1;
    if (items.length >= maximum) continue;
    items.push({
      frame_id: frameId,
      parent_frame_id:
        (stringValue(frame.parentId) ?? "").slice(0, 256) || null,
      url: sanitized.url,
      origin: sanitized.origin,
    });
  }
  return { total, items };
};

/** Read the current main-frame URL from an untrusted Page.getFrameTree result. */
export const mainFrameUrl = (result: unknown): string | undefined =>
  stringValue(
    recordValue(recordValue(requiredRecord(result).frameTree)?.frame)?.url,
  );

/** Normalize allowed resources while retaining a bounded prefix and total count. */
export const captureResources = (
  result: unknown,
  allowedOrigins: ReadonlySet<string>,
  maximum: number,
): {
  readonly total: number;
  readonly items: WebPageInspection["resources"];
} => {
  const root = recordValue(requiredRecord(result).frameTree);
  if (root === undefined) return { total: 0, items: [] };
  const items: WebPageInspection["resources"] = [];
  let total = 0;
  for (const tree of walkFrameTrees(root)) {
    for (const resource of recordsValue(tree.resources)) {
      const url = allowedSanitizedUrl(resource.url, allowedOrigins);
      if (url === undefined || url.origin === null) continue;
      total += 1;
      if (items.length >= maximum) continue;
      const contentSize = numberValue(resource.contentSize);
      items.push({
        url: url.url,
        origin: url.origin,
        type: (stringValue(resource.type) ?? "Other").slice(0, 100),
        mime_type: (stringValue(resource.mimeType) ?? "").slice(0, 256),
        content_size:
          contentSize === undefined ? null : Math.max(0, contentSize),
      });
    }
  }
  return { total, items };
};

const walkFrameTrees = function* (
  root: UnknownRecord,
): Generator<UnknownRecord> {
  const pending = [root];
  while (pending.length > 0) {
    const tree = pending.pop();
    if (tree === undefined) return;
    const children = recordsValue(tree.childFrames);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) pending.push(child);
    }
    yield tree;
  }
};

export const captureDom = (
  result: unknown,
  allowedOrigins: ReadonlySet<string>,
  input: InspectWebPageInput,
): {
  readonly total: number;
  readonly nodes: WebPageInspection["dom"]["nodes"];
} => {
  const root = requiredRecord(result);
  const strings = Array.isArray(root.strings)
    ? root.strings.map((value) => stringValue(value) ?? "")
    : [];
  const nodes: WebPageInspection["dom"]["nodes"] = [];
  let total = 0;
  for (const document of recordsValue(root.documents)) {
    const documentUrl = indexedString(strings, document.documentURL);
    if (allowedSanitizedUrl(documentUrl, allowedOrigins) === undefined)
      continue;
    const documentNodes = recordValue(document.nodes);
    if (documentNodes === undefined) continue;
    const nodeTypes = numberArray(documentNodes.nodeType);
    const nodeNames = numberArray(documentNodes.nodeName);
    const nodeValues = numberArray(documentNodes.nodeValue);
    const parents = numberArray(documentNodes.parentIndex);
    const attributes = Array.isArray(documentNodes.attributes)
      ? documentNodes.attributes
      : [];
    const baseIndex = nodes.length;
    total += nodeTypes.length;
    for (
      let index = 0;
      index < nodeTypes.length && nodes.length < input.limits.max_dom_nodes;
      index += 1
    ) {
      const attributeIndexes = numberArray(attributes[index]);
      const parent = Math.trunc(parents[index] ?? -1);
      nodes.push({
        index: nodes.length,
        parent_index: parent < 0 ? -1 : baseIndex + parent,
        node_type: Math.max(0, Math.trunc(nodeTypes[index] ?? 0)),
        node_name: indexedString(strings, nodeNames[index]).slice(0, 256),
        node_value_length: indexedString(strings, nodeValues[index]).length,
        attribute_names: attributeIndexes
          .filter((_value, attributeIndex) => attributeIndex % 2 === 0)
          .map((value) => indexedString(strings, value).slice(0, 256))
          .slice(0, 200),
      });
    }
  }
  return { total, nodes };
};

export const captureAccessibility = (
  results: readonly unknown[],
  maximum: number,
): {
  readonly total: number;
  readonly nodes: WebPageInspection["accessibility"]["nodes"];
} => {
  const all = results.flatMap((result) =>
    recordsValue(requiredRecord(result).nodes),
  );
  return {
    total: all.length,
    nodes: all.slice(0, maximum).map((node) => ({
      node_id: (stringValue(node.nodeId) ?? "").slice(0, 256),
      parent_id: (stringValue(node.parentId) ?? "").slice(0, 256) || null,
      role: axText(node.role),
      name: axText(node.name),
      description: axText(node.description),
      ignored: node.ignored === true,
    })),
  };
};

const axText = (value: unknown): string | null =>
  boundedText(recordValue(value)?.value, 1_024);

const indexedString = (strings: readonly string[], index: unknown): string => {
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
