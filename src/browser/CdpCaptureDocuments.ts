import type {
  InspectWebPageInput,
  WebPageInspection,
} from "../domain/browserObservation.js";
import {
  allowedSanitizedUrl,
  numberValue,
  recordValue,
  recordsValue,
  requiredRecord,
  stringValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";
import { exclusionReasonForUrl } from "./CdpCaptureEventHelpers.js";
import type { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";

export type CapturedResource = Omit<
  WebPageInspection["resources"][number],
  "resource_key"
> & { readonly rawUrl: string };

/** Normalize every allowed frame, optionally selecting a leading frame. */
export const captureFrames = (
  result: unknown,
  allowedOrigins: ReadonlySet<string>,
  maximum?: number,
  completeness?: CdpCaptureCompleteness,
): {
  readonly items: WebPageInspection["frames"];
} => {
  const root = recordValue(recordValue(result)?.frameTree);
  if (root === undefined) {
    completeness?.exclude("frames", "invalid_protocol_value");
    return { items: [] };
  }
  const items: WebPageInspection["frames"] = [];
  for (const tree of walkFrameTrees(root, () =>
    completeness?.exclude("frames", "invalid_protocol_value"),
  )) {
    const frame = recordValue(tree.frame);
    const frameId = stringValue(frame?.id);
    const sanitized = allowedSanitizedUrl(frame?.url, allowedOrigins);
    if (frame === undefined || frameId === undefined) {
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
    if (maximum !== undefined && items.length >= maximum) continue;
    items.push({
      frame_id: frameId,
      parent_frame_id: stringValue(frame.parentId) ?? null,
      url: sanitized.url,
      origin: sanitized.origin,
    });
  }
  return { items };
};

/** Read the current main-frame URL from an untrusted Page.getFrameTree result. */
export const mainFrameUrl = (result: unknown): string | undefined =>
  stringValue(
    recordValue(recordValue(requiredRecord(result).frameTree)?.frame)?.url,
  );

/** Normalize every allowed resource. */
export const captureResources = (
  result: unknown,
  allowedOrigins: ReadonlySet<string>,
  completeness?: CdpCaptureCompleteness,
): {
  readonly items: readonly CapturedResource[];
} => {
  const root = recordValue(recordValue(result)?.frameTree);
  if (root === undefined) {
    completeness?.exclude("resources", "invalid_protocol_value");
    return { items: [] };
  }
  const items: CapturedResource[] = [];
  for (const tree of walkFrameTrees(root, () =>
    completeness?.exclude("resources", "invalid_protocol_value"),
  )) {
    for (const resource of recordsValue(tree.resources)) {
      const url = allowedSanitizedUrl(resource.url, allowedOrigins);
      if (url === undefined || url.origin === null) {
        completeness?.exclude(
          "resources",
          exclusionReasonForUrl(stringValue(resource.url)),
        );
        continue;
      }
      const contentSize = numberValue(resource.contentSize);
      items.push({
        rawUrl: stringValue(resource.url) ?? "",
        url: url.url,
        origin: url.origin,
        type: stringValue(resource.type) ?? "Other",
        mime_type: stringValue(resource.mimeType) ?? "",
        content_size:
          contentSize === undefined ? null : Math.max(0, contentSize),
      });
    }
  }
  return { items };
};

export const walkFrameTrees = function* (
  root: UnknownRecord,
  onMalformedChild?: () => void,
): Generator<UnknownRecord> {
  const pending = [root];
  while (pending.length > 0) {
    const tree = pending.pop();
    if (tree === undefined) return;
    const rawChildren = tree.childFrames;
    if (rawChildren !== undefined && !Array.isArray(rawChildren))
      onMalformedChild?.();
    const children = Array.isArray(rawChildren)
      ? rawChildren.flatMap((child) => {
          const parsed = recordValue(child);
          if (parsed === undefined) onMalformedChild?.();
          return parsed === undefined ? [] : [parsed];
        })
      : [];
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
    for (let index = 0; index < nodeTypes.length; index += 1) {
      const attributeIndexes = numberArray(attributes[index]);
      const parent = Math.trunc(parents[index] ?? -1);
      const nodeIndex = nodes.length;
      const nodeName = indexedString(strings, nodeNames[index]);
      nodes.push({
        index: nodeIndex,
        parent_index: parent < 0 ? -1 : baseIndex + parent,
        node_type: Math.max(0, Math.trunc(nodeTypes[index] ?? 0)),
        node_name: nodeName,
        node_value_length: indexedString(strings, nodeValues[index]).length,
        attribute_names: attributeIndexes
          .filter((_value, attributeIndex) => attributeIndex % 2 === 0)
          .map((value) => indexedString(strings, value)),
      });
      const metadata = domMetadata({
        strings,
        attributes: attributeIndexes,
        documentUrl,
        nodeIndex,
        nodeName,
        allowedOrigins,
      });
      for (const url of metadata.urls) {
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
    agentHints,
    excludedUrls,
  };
};

export const captureAccessibility = (
  results: readonly unknown[],
  options: {
    readonly includeText: boolean;
    readonly unavailable?: boolean;
  },
): {
  readonly total: number;
  readonly nodes: WebPageInspection["accessibility"]["nodes"];
  readonly textCapture: WebPageInspection["accessibility"]["text_capture"];
  readonly treeIncomplete: boolean;
} => {
  const all = results.flatMap((result) =>
    recordsValue(requiredRecord(result).nodes),
  );
  const nodeIds = new Set(
    all.flatMap((node) => {
      const nodeId = stringValue(node.nodeId);
      return nodeId === undefined ? [] : [nodeId];
    }),
  );
  let excludedFields = 0;
  const nodes = all.map((node) => {
    const captureText = (value: unknown): string | null => {
      const raw = stringValue(recordValue(value)?.value);
      if (raw === undefined) return null;
      if (!options.includeText) {
        excludedFields += 1;
        return null;
      }
      return raw;
    };
    return {
      node_id: stringValue(node.nodeId) ?? "",
      parent_id: stringValue(node.parentId) ?? null,
      role: axText(node.role),
      name: captureText(node.name),
      description: captureText(node.description),
      ignored: node.ignored === true,
      states: accessibilityStates(node.properties),
    };
  });
  return {
    total: all.length,
    nodes,
    treeIncomplete: all.some(
      (node) =>
        Array.isArray(node.childIds) &&
        node.childIds.some((childId) => {
          const id = stringValue(childId);
          return id !== undefined && !nodeIds.has(id);
        }),
    ),
    textCapture: {
      status: options.unavailable
        ? "unavailable"
        : !options.includeText
          ? "not_approved"
          : "included",
      retained_bytes: nodes.reduce(
        (total, node) =>
          total +
          Buffer.byteLength(node.name ?? "") +
          Buffer.byteLength(node.description ?? ""),
        0,
      ),
      excluded_fields: excludedFields,
    },
  };
};

const ACCESSIBILITY_STATE_NAMES = new Set([
  "atomic",
  "autocomplete",
  "busy",
  "checked",
  "disabled",
  "editable",
  "expanded",
  "focusable",
  "focused",
  "hasPopup",
  "hidden",
  "invalid",
  "level",
  "live",
  "modal",
  "multiline",
  "multiselectable",
  "orientation",
  "pressed",
  "readonly",
  "required",
  "selected",
  "valuemax",
  "valuemin",
]);

const accessibilityStates = (
  value: unknown,
): WebPageInspection["accessibility"]["nodes"][number]["states"] => {
  const states = new Map<string, boolean | number | string>();
  for (const property of recordsValue(value)) {
    const name = stringValue(property.name);
    if (name === undefined || !ACCESSIBILITY_STATE_NAMES.has(name)) continue;
    const raw = recordValue(property.value)?.value;
    const state =
      typeof raw === "boolean"
        ? raw
        : typeof raw === "number"
          ? numberValue(raw)
          : typeof raw === "string"
            ? raw
            : undefined;
    if (state !== undefined) states.set(name, state);
  }
  return [...states]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, state]) => ({ name, value: state }));
};

const axText = (value: unknown): string | null =>
  stringValue(recordValue(value)?.value) ?? null;

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

interface DomMetadataOptions {
  readonly strings: readonly string[];
  readonly attributes: readonly number[];
  readonly documentUrl: string;
  readonly nodeIndex: number;
  readonly nodeName: string;
  readonly allowedOrigins: ReadonlySet<string>;
}

const domMetadata = (
  options: DomMetadataOptions,
): {
  readonly urls: WebPageInspection["metadata"]["dom_urls"];
  readonly agentHints: WebPageInspection["metadata"]["agent_hints"];
} => {
  const {
    strings,
    attributes,
    documentUrl,
    nodeIndex,
    nodeName,
    allowedOrigins,
  } = options;
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

const domUrlAttributes = [
  "href",
  "src",
  "action",
  "formaction",
  "poster",
] as const;
const agentRelValues = ["mcp", "model-context", "ai-plugin", "service-desc"];
