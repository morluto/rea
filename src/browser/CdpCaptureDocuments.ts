import type { InspectWebPageInput } from "../domain/browserObservation.js";
import type { WebPageInspection } from "../domain/browserObservationSchemas.js";
import {
  allowedSanitizedUrl,
  numberValue,
  recordValue,
  recordsValue,
  requiredRecord,
  cdpStringValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";
import { exclusionReasonForUrl } from "./CdpCaptureEventHelpers.js";
import type { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import {
  createDocumentSvgAncestry,
  domSvgLink,
  type DomSvgNodeQuery,
} from "./CdpCaptureDomSvg.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";

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
    const frameId = cdpStringValue(frame?.id);
    const sanitized = allowedSanitizedUrl(frame?.url, allowedOrigins);
    if (frame === undefined || frameId === undefined) {
      completeness?.exclude("frames", "invalid_protocol_value");
      continue;
    }
    if (sanitized === undefined || sanitized.origin === null) {
      completeness?.exclude(
        "frames",
        exclusionReasonForUrl(cdpStringValue(frame.url)),
      );
      continue;
    }
    if (maximum !== undefined && items.length >= maximum) continue;
    items.push({
      frame_id: frameId,
      parent_frame_id: cdpStringValue(frame.parentId) ?? null,
      url: sanitized.url,
      origin: sanitized.origin,
    });
  }
  return { items };
};

/** Read the current main-frame URL from an untrusted Page.getFrameTree result. */
export const mainFrameUrl = (result: unknown): string | undefined =>
  cdpStringValue(
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
          exclusionReasonForUrl(cdpStringValue(resource.url)),
        );
        continue;
      }
      const contentSize = numberValue(resource.contentSize);
      items.push({
        rawUrl: cdpStringValue(resource.url) ?? "",
        url: url.url,
        origin: url.origin,
        type: cdpStringValue(resource.type) ?? "Other",
        mime_type: cdpStringValue(resource.mimeType) ?? "",
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

interface DomMetadataCapture {
  readonly urls: WebPageInspection["metadata"]["dom_urls"];
  readonly agentHints: WebPageInspection["metadata"]["agent_hints"];
  readonly excludedUrls: number;
  readonly unresolvedSvgNodes: number;
}

export interface DomCapture extends DomMetadataCapture {
  readonly total: number;
  readonly nodes: WebPageInspection["dom"]["nodes"];
}

// Bound retained projections and outstanding CDP reads independently of page size.
// Eight leaves room for the session's other cancellation listeners.
const DOM_METADATA_BATCH_SIZE = 8;

interface PendingDomMetadata {
  readonly options: DomMetadataOptions;
  // Undefined means no query is needed; null means the candidate has no valid ID.
  readonly svgQuery: DomSvgNodeQuery | null | undefined;
}

/** Project one snapshot, requesting bounded batches of SVG identity facts. */
export function* captureDom(
  result: unknown,
  allowedOrigins: ReadonlySet<string>,
  input: InspectWebPageInput,
  completeness?: CdpCaptureCompleteness,
): Generator<
  readonly DomSvgNodeQuery[],
  DomCapture,
  readonly (boolean | undefined)[]
> {
  const root = requiredRecord(result);
  const strings = Array.isArray(root.strings)
    ? root.strings.map((value) => cdpStringValue(value) ?? "")
    : [];
  const nodes: WebPageInspection["dom"]["nodes"] = [];
  const urls: WebPageInspection["metadata"]["dom_urls"] = [];
  const agentHints: WebPageInspection["metadata"]["agent_hints"] = [];
  let excludedUrls = 0;
  let total = 0;
  let unresolvedSvgNodes = 0;
  for (const document of recordsValue(root.documents)) {
    const documentUrl = indexedString(strings, document.documentURL);
    if (allowedSanitizedUrl(documentUrl, allowedOrigins) === undefined) {
      completeness?.exclude("dom", exclusionReasonForUrl(documentUrl));
      continue;
    }
    const baseUrl = indexedString(strings, document.baseURL) || documentUrl;
    const documentNodes = recordValue(document.nodes);
    if (documentNodes === undefined) continue;
    const nodeTypes = numberArray(documentNodes.nodeType);
    const nodeNames = numberArray(documentNodes.nodeName);
    const nodeValues = numberArray(documentNodes.nodeValue);
    const parents = numberArray(documentNodes.parentIndex);
    const attributes = Array.isArray(documentNodes.attributes)
      ? documentNodes.attributes
      : [];
    const backendNodeIds = Array.isArray(documentNodes.backendNodeId)
      ? documentNodes.backendNodeId
      : [];
    const baseIndex = nodes.length;
    const ancestry = createDocumentSvgAncestry({
      nodeTypes,
      nodeNames,
      parents,
      strings,
      attributes,
    });
    total += nodeTypes.length;
    const pendingMetadata: PendingDomMetadata[] = [];
    for (let index = 0; index < nodeTypes.length; index += 1) {
      const attributeIndexes = numberArray(attributes[index]);
      const parent = Math.trunc(parents[index] ?? -1);
      const nodeIndex = nodes.length;
      const nodeName = indexedString(strings, nodeNames[index]);
      const attributeNames = uniqueAttributeNames(attributeIndexes, strings);
      const svgLink = domSvgLink(ancestry, index);
      let svgQuery: DomSvgNodeQuery | null | undefined;
      if (
        !svgLink.xmlDocument &&
        nodeTypes[index] === 1 &&
        attributeNames.includes("xlink:href") &&
        !attributeNames.includes("href")
      ) {
        const backendNodeId = numberValue(backendNodeIds[index]);
        svgQuery =
          backendNodeId !== undefined &&
          Number.isSafeInteger(backendNodeId) &&
          backendNodeId > 0
            ? { backendNodeId, nodeName }
            : null;
      }
      nodes.push({
        index: nodeIndex,
        parent_index: parent < 0 ? -1 : baseIndex + parent,
        node_type: Math.max(0, Math.trunc(nodeTypes[index] ?? 0)),
        node_name: nodeName,
        node_value_length: indexedString(strings, nodeValues[index]).length,
        attribute_names: attributeNames,
      });
      pendingMetadata.push({
        svgQuery,
        options: {
          strings,
          attributes: attributeIndexes,
          // The BASE element itself resolves against the document fallback URL.
          baseUrl: nodeName.toLowerCase() === "base" ? documentUrl : baseUrl,
          documentUrl,
          nodeIndex,
          nodeName,
          allowedOrigins,
          ...svgLink,
        },
      });
      if (
        pendingMetadata.length === DOM_METADATA_BATCH_SIZE ||
        index === nodeTypes.length - 1
      ) {
        const metadata = yield* captureDomMetadata(
          pendingMetadata,
          completeness,
        );
        urls.push(...metadata.urls);
        agentHints.push(...metadata.agentHints);
        excludedUrls += metadata.excludedUrls;
        unresolvedSvgNodes += metadata.unresolvedSvgNodes;
        pendingMetadata.length = 0;
      }
    }
  }
  return {
    total,
    nodes,
    urls,
    agentHints,
    excludedUrls,
    unresolvedSvgNodes,
  };
}

function* captureDomMetadata(
  pending: readonly PendingDomMetadata[],
  completeness: CdpCaptureCompleteness | undefined,
): Generator<
  readonly DomSvgNodeQuery[],
  DomMetadataCapture,
  readonly (boolean | undefined)[]
> {
  const queries = pending.flatMap(({ svgQuery }) =>
    svgQuery == null ? [] : [svgQuery],
  );
  const kinds = queries.length > 0 ? yield queries : [];
  const urls: DomMetadataCapture["urls"] = [];
  const agentHints: DomMetadataCapture["agentHints"] = [];
  let queryIndex = 0;
  let unresolvedSvgNodes = 0;
  let excludedUrls = 0;
  for (const { options, svgQuery } of pending) {
    let svgElement = options.svgElement;
    if (svgQuery !== undefined) {
      const kind = svgQuery === null ? undefined : kinds[queryIndex++];
      svgElement = kind === true;
      if (kind === undefined) {
        unresolvedSvgNodes += 1;
        completeness?.exclude("metadata", "provider_unavailable");
      }
    }
    const metadata = domMetadata({ ...options, svgElement });
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
  return { urls, agentHints, unresolvedSvgNodes, excludedUrls };
}

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
      const nodeId = cdpStringValue(node.nodeId);
      return nodeId === undefined ? [] : [nodeId];
    }),
  );
  let excludedFields = 0;
  const nodes = all.map((node) => {
    const captureText = (value: unknown): string | null => {
      const raw = cdpStringValue(recordValue(value)?.value);
      if (raw === undefined) return null;
      if (!options.includeText) {
        excludedFields += 1;
        return null;
      }
      return raw;
    };
    return {
      node_id: cdpStringValue(node.nodeId) ?? "",
      parent_id: cdpStringValue(node.parentId) ?? null,
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
          const id = cdpStringValue(childId);
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
    const name = cdpStringValue(property.name);
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
    .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
    .map(([name, state]) => ({ name, value: state }));
};

const axText = (value: unknown): string | null =>
  cdpStringValue(recordValue(value)?.value) ?? null;

const indexedString = (strings: readonly string[], index: unknown): string => {
  const integer = numberValue(index);
  return integer === undefined ? "" : (strings[Math.trunc(integer)] ?? "");
};

const uniqueAttributeNames = (
  attributeIndexes: readonly number[],
  strings: readonly string[],
): string[] => {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < attributeIndexes.length; index += 2) {
    const name = indexedString(strings, attributeIndexes[index]);
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
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
  readonly baseUrl: string;
  readonly documentUrl: string;
  readonly nodeIndex: number;
  readonly nodeName: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly svgElement: boolean;
  readonly xmlDocument: boolean;
  readonly xlinkHref: string | undefined;
}

// Chrome reads an SVG XLink href only when href itself is absent, and an
// empty href still wins. HTML keeps the literal attribute name `xlink:href`.
// XML uses any prefix bound to the XLink namespace. Both are stored as href.
const hrefAttributeValue = (
  pairs: ReadonlyMap<string, string>,
  attribute: string,
  options: DomMetadataOptions,
): string | undefined => {
  const declared = pairs.get(attribute);
  if (declared !== undefined) return declared;
  if (attribute !== "href" || !options.svgElement) return undefined;
  return options.xmlDocument ? options.xlinkHref : pairs.get("xlink:href");
};

const domMetadata = (
  options: DomMetadataOptions,
): {
  readonly urls: WebPageInspection["metadata"]["dom_urls"];
  readonly agentHints: WebPageInspection["metadata"]["agent_hints"];
} => {
  const {
    strings,
    attributes,
    baseUrl,
    documentUrl,
    nodeIndex,
    nodeName,
    allowedOrigins,
  } = options;
  const pairs = new Map<string, string>();
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    // Chrome already folds HTML names; SVG/XML names remain case-sensitive.
    const name = indexedString(strings, attributes[index]);
    const value = indexedString(strings, attributes[index + 1]);
    // HTML keeps the first declaration. A later repeat must not move dom_urls.
    if (!pairs.has(name)) pairs.set(name, value);
  }
  const urls: WebPageInspection["metadata"]["dom_urls"] = [];
  for (const attribute of domUrlAttributes) {
    const value = hrefAttributeValue(pairs, attribute, options);
    if (value === undefined) continue;
    const tagName = nodeName.toLowerCase();
    // Chrome strips HTML whitespace for FORM.action, while submit controls
    // use the document URL only for an exactly empty formaction attribute.
    const usesDocumentUrl =
      (tagName === "form" &&
        attribute === "action" &&
        /^[\t\n\f\r ]*$/u.test(value)) ||
      ((tagName === "button" || tagName === "input") &&
        attribute === "formaction" &&
        value === "");
    const destination = domDestination(
      usesDocumentUrl ? documentUrl : value,
      baseUrl,
      allowedOrigins,
    );
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
  baseUrl: string,
  allowedOrigins: ReadonlySet<string>,
): {
  readonly url: string | null;
  readonly scope: "approved" | "outside_policy" | "unsupported";
} => {
  try {
    const parsed = new URL(value, baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return { url: null, scope: "unsupported" };
    if (!allowedOrigins.has(parsed.origin))
      return { url: null, scope: "outside_policy" };
    return {
      url: allowedSanitizedUrl(parsed.href, allowedOrigins)?.url ?? null,
      scope: "approved",
    };
  } catch (cause: unknown) {
    // Unparseable URLs are out of scope, not failures.
    void cause;
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
