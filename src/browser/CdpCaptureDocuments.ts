import type {
  InspectWebPageInput,
  WebPageInspection,
} from "../domain/browserObservation.js";
import {
  allowedSanitizedUrl,
  boundedText,
  isHttpUrl,
  numberValue,
  recordValue,
  recordsValue,
  requiredRecord,
  stringValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";
import type { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";

export type CapturedResource = Omit<
  WebPageInspection["resources"][number],
  "resource_key"
> & { readonly rawUrl: string };

/** Normalize allowed frames while retaining a bounded prefix and total count. */
export const captureFrames = (
  result: unknown,
  allowedOrigins: ReadonlySet<string>,
  maximum: number,
  completeness?: CdpCaptureCompleteness,
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
    if (frame === undefined || frameId === undefined || frameId.length > 256) {
      completeness?.exclude("frames", "invalid_protocol_value");
      continue;
    }
    if (sanitized === undefined || sanitized.origin === null) {
      completeness?.exclude(
        "frames",
        exclusionReasonForUrl(stringValue(frame.url)),
      );
      continue;
    }
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
  completeness?: CdpCaptureCompleteness,
): {
  readonly total: number;
  readonly items: readonly CapturedResource[];
} => {
  const root = recordValue(requiredRecord(result).frameTree);
  if (root === undefined) return { total: 0, items: [] };
  const items: CapturedResource[] = [];
  let total = 0;
  for (const tree of walkFrameTrees(root)) {
    for (const resource of recordsValue(tree.resources)) {
      const url = allowedSanitizedUrl(resource.url, allowedOrigins);
      if (url === undefined || url.origin === null) {
        completeness?.exclude(
          "resources",
          exclusionReasonForUrl(stringValue(resource.url)),
        );
        continue;
      }
      total += 1;
      if (items.length >= maximum) continue;
      const contentSize = numberValue(resource.contentSize);
      items.push({
        rawUrl: stringValue(resource.url) ?? "",
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
  completeness?: CdpCaptureCompleteness,
): {
  readonly total: number;
  readonly nodes: WebPageInspection["dom"]["nodes"];
  readonly urls: WebPageInspection["metadata"]["dom_urls"];
  readonly agentHints: WebPageInspection["metadata"]["agent_hints"];
  readonly excludedUrls: number;
} => {
  const root = requiredRecord(result);
  const strings = Array.isArray(root.strings)
    ? root.strings.map((value) => stringValue(value) ?? "")
    : [];
  const nodes: WebPageInspection["dom"]["nodes"] = [];
  const urls: WebPageInspection["metadata"]["dom_urls"] = [];
  const agentHints: WebPageInspection["metadata"]["agent_hints"] = [];
  let excludedUrls = 0;
  let total = 0;
  for (const document of recordsValue(root.documents)) {
    const documentUrl = indexedString(strings, document.documentURL);
    if (allowedSanitizedUrl(documentUrl, allowedOrigins) === undefined) {
      completeness?.exclude("dom", exclusionReasonForUrl(documentUrl));
      continue;
    }
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
      const nodeIndex = nodes.length;
      const nodeName = indexedString(strings, nodeNames[index]).slice(0, 256);
      nodes.push({
        index: nodeIndex,
        parent_index: parent < 0 ? -1 : baseIndex + parent,
        node_type: Math.max(0, Math.trunc(nodeTypes[index] ?? 0)),
        node_name: nodeName,
        node_value_length: indexedString(strings, nodeValues[index]).length,
        attribute_names: attributeIndexes
          .filter((_value, attributeIndex) => attributeIndex % 2 === 0)
          .map((value) => indexedString(strings, value).slice(0, 256))
          .slice(0, 200),
      });
      const metadata = domMetadata(
        strings,
        attributeIndexes,
        documentUrl,
        nodeIndex,
        nodeName,
        allowedOrigins,
      );
      for (const url of metadata.urls) {
        if (urls.length >= input.limits.max_resources) {
          completeness?.truncate("metadata");
          continue;
        }
        urls.push(url);
        if (url.destination_scope !== "approved") {
          excludedUrls += 1;
          completeness?.exclude(
            "metadata",
            url.destination_scope === "outside_policy"
              ? "disallowed_origin"
              : "unsupported_url",
          );
        }
      }
      agentHints.push(...metadata.agentHints);
    }
  }
  return {
    total,
    nodes,
    urls,
    agentHints: agentHints.slice(0, input.limits.max_resources),
    excludedUrls,
  };
};

export const captureAccessibility = (
  results: readonly unknown[],
  maximum: number,
  options: {
    readonly includeText: boolean;
    readonly maximumFieldBytes: number;
    readonly maximumTotalBytes: number;
    readonly unavailable?: boolean;
  },
): {
  readonly total: number;
  readonly nodes: WebPageInspection["accessibility"]["nodes"];
  readonly textCapture: WebPageInspection["accessibility"]["text_capture"];
} => {
  const all = results.flatMap((result) =>
    recordsValue(requiredRecord(result).nodes),
  );
  let retainedBytes = 0;
  let excludedFields = 0;
  let truncatedFields = 0;
  const nodes = all.slice(0, maximum).map((node) => {
    const captureText = (value: unknown): string | null => {
      const raw = stringValue(recordValue(value)?.value);
      if (raw === undefined) return null;
      if (!options.includeText) {
        excludedFields += 1;
        return null;
      }
      const available = Math.max(0, options.maximumTotalBytes - retainedBytes);
      const captured = boundedUtf8(
        raw,
        Math.min(options.maximumFieldBytes, available),
      );
      retainedBytes += captured.bytes;
      if (captured.truncated) {
        truncatedFields += 1;
        if (captured.text === "" && raw !== "") {
          excludedFields += 1;
          return null;
        }
      }
      return captured.text;
    };
    return {
      node_id: (stringValue(node.nodeId) ?? "").slice(0, 256),
      parent_id: (stringValue(node.parentId) ?? "").slice(0, 256) || null,
      role: axText(node.role),
      name: captureText(node.name),
      description: captureText(node.description),
      ignored: node.ignored === true,
    };
  });
  for (const node of all.slice(maximum)) {
    for (const value of [node.name, node.description]) {
      if (stringValue(recordValue(value)?.value) === undefined) continue;
      excludedFields += 1;
      if (options.includeText) truncatedFields += 1;
    }
  }
  return {
    total: all.length,
    nodes,
    textCapture: {
      status: options.unavailable
        ? "unavailable"
        : !options.includeText
          ? "not_approved"
          : truncatedFields > 0
            ? "truncated"
            : "included",
      retained_bytes: retainedBytes,
      excluded_fields: excludedFields,
      truncated_fields: truncatedFields,
    },
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

const domMetadata = (
  strings: readonly string[],
  attributes: readonly number[],
  documentUrl: string,
  nodeIndex: number,
  nodeName: string,
  allowedOrigins: ReadonlySet<string>,
): {
  readonly urls: WebPageInspection["metadata"]["dom_urls"];
  readonly agentHints: WebPageInspection["metadata"]["agent_hints"];
} => {
  const pairs = new Map<string, string>();
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    const name = indexedString(strings, attributes[index]).toLowerCase();
    const value = indexedString(strings, attributes[index + 1]);
    pairs.set(name, value);
  }
  const urls: WebPageInspection["metadata"]["dom_urls"] = [];
  for (const attribute of domUrlAttributes) {
    const value = pairs.get(attribute);
    if (value === undefined) continue;
    const destination = domDestination(value, documentUrl, allowedOrigins);
    urls.push({
      node_index: nodeIndex,
      attribute,
      url: destination.url,
      destination_scope: destination.scope,
    });
  }
  const rel = (pairs.get("rel") ?? "")
    .toLowerCase()
    .split(/\s+/u)
    .filter((value) => agentRelValues.includes(value));
  const href = urls.find(({ attribute }) => attribute === "href")?.url ?? null;
  const agentHints =
    nodeName.toLowerCase() === "link" && rel.length > 0
      ? rel.map((declaration) => ({
          mechanism: "dom_link_rel" as const,
          declaration,
          url: href,
          trust: "page-declared-untrusted" as const,
        }))
      : [];
  return { urls, agentHints };
};

const domDestination = (
  value: string,
  documentUrl: string,
  allowedOrigins: ReadonlySet<string>,
): {
  readonly url: string | null;
  readonly scope: "approved" | "outside_policy" | "unsupported";
} => {
  try {
    const parsed = new URL(value, documentUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return { url: null, scope: "unsupported" };
    if (!allowedOrigins.has(parsed.origin))
      return { url: null, scope: "outside_policy" };
    return {
      url: allowedSanitizedUrl(parsed.href, allowedOrigins)?.url ?? null,
      scope: "approved",
    };
  } catch {
    return { url: null, scope: "unsupported" };
  }
};

const boundedUtf8 = (
  value: string,
  maximumBytes: number,
): {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
} => {
  const total = Buffer.byteLength(value);
  if (total <= maximumBytes)
    return { text: value, bytes: total, truncated: false };
  let text = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maximumBytes) break;
    text += character;
    bytes += characterBytes;
  }
  return { text, bytes, truncated: true };
};

const exclusionReasonForUrl = (
  value: string | undefined,
): "disallowed_origin" | "unsupported_url" | "unattributed_origin" =>
  value === undefined || value === ""
    ? "unattributed_origin"
    : isHttpUrl(value)
      ? "disallowed_origin"
      : "unsupported_url";

const domUrlAttributes = [
  "href",
  "src",
  "action",
  "formaction",
  "poster",
] as const;
const agentRelValues = ["mcp", "model-context", "ai-plugin", "service-desc"];
