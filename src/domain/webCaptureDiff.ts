import { digestCanonicalValue } from "./canonicalDigest.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import type { WebPageInspection } from "./browserObservationSchemas.js";
import {
  webCaptureDiffSchema,
  type CompareWebCapturesInput,
  type WebCaptureChange,
  type WebCaptureDiff,
  type WebCaptureDimension,
} from "./webCaptureDiffSchemas.js";
import type { WebMcpDiscovery } from "./webMcpDiscovery.js";

type Dimension = WebCaptureDimension;
type Change = WebCaptureChange;

/** Compare normalized observations without treating incomplete absence as proof. */
export const compareWebCaptures = (
  input: CompareWebCapturesInput,
): WebCaptureDiff => {
  const before = input.before.inspection;
  const after = input.after.inspection;
  const dimensions = compareWebCaptureDimensions(input);
  const statuses = Object.values(dimensions).map(({ status }) => status);
  return webCaptureDiffSchema.parse({
    overall_status: statuses.includes("changed")
      ? "changed"
      : statuses.includes("unknown")
        ? "unknown"
        : "unchanged",
    before_target: {
      target_id: before.target.target_id,
      url: before.target.url,
    },
    after_target: {
      target_id: after.target.target_id,
      url: after.target.url,
    },
    dimensions,
    limitations: [
      "A changed status proves an observed difference; an unknown status means absence could not be established from capture completeness.",
      "Network comparison covers only activity observed after each CDP attachment.",
      "Accessibility roles, ignored state, text, and hierarchy are compared only when the accessibility tree was fully captured and text capture was selected and not truncated.",
      "Storage key inventories are compared only when selected and complete; usage and quota are compared only when reported. Redacted content is compared through complete SHA-256 fingerprints.",
    ],
  });
};

const compareIdentities = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): Change[] => {
  const changes: Change[] = [];
  for (const [identity, fingerprint] of before) {
    const next = after.get(identity);
    if (next === undefined) changes.push({ identity, change: "removed" });
    else if (next !== fingerprint)
      changes.push({ identity, change: "modified" });
  }
  for (const identity of after.keys())
    if (!before.has(identity)) changes.push({ identity, change: "added" });
  return changes.sort(
    (left, right) =>
      compareUnicodeCodePoints(left.identity, right.identity) ||
      compareUnicodeCodePoints(left.change, right.change),
  );
};

const compareDimension = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  complete: boolean,
  reason: string,
): Dimension => {
  const all = compareIdentities(before, after).filter(
    ({ change }) => complete || change === "modified",
  );
  if (all.length > 0)
    return {
      status: "changed",
      total_changes: all.length,
      changes: all,
      reason: null,
    };
  return complete
    ? {
        status: "unchanged",
        total_changes: 0,
        changes: [],
        reason: null,
      }
    : {
        status: "unknown",
        total_changes: 0,
        changes: [],
        reason,
      };
};

const accessibilityDimension = (
  before: WebPageInspection,
  after: WebPageInspection,
): Dimension => {
  const beforeAccess = accessibilityComparable(before);
  const afterAccess = accessibilityComparable(after);
  const textComparable = beforeAccess.text && afterAccess.text;
  const nodesComparable = beforeAccess.nodes && afterAccess.nodes;
  return compareDimension(
    singleton(
      "accessibility_tree",
      digestCanonicalValue(
        accessibilityProjection(
          before.accessibility,
          textComparable,
          nodesComparable,
        ),
      ),
    ),
    singleton(
      "accessibility_tree",
      digestCanonicalValue(
        accessibilityProjection(
          after.accessibility,
          textComparable,
          nodesComparable,
        ),
      ),
    ),
    beforeAccess.complete && afterAccess.complete,
    "Accessibility tree or text capture was incomplete in at least one observation.",
  );
};

const storageDimension = (
  before: WebPageInspection,
  after: WebPageInspection,
): Dimension => {
  const keysComplete =
    storageKeysComparable(before) && storageKeysComparable(after);
  const usageComplete =
    before.storage.usage_bytes !== null &&
    after.storage.usage_bytes !== null &&
    before.storage.quota_bytes !== null &&
    after.storage.quota_bytes !== null;
  const comparableFingerprints = storageFingerprintIdentities(
    before.storage,
    after.storage,
  );
  return compareDimension(
    storageMap(
      before.storage,
      keysComplete,
      usageComplete,
      comparableFingerprints,
    ),
    storageMap(
      after.storage,
      keysComplete,
      usageComplete,
      comparableFingerprints,
    ),
    storageComparable(before, after, keysComplete, usageComplete),
    "Storage fingerprints, inventories, usage, or quota were unavailable or truncated in at least one observation.",
  );
};

const compareWebCaptureDimensions = (
  input: CompareWebCapturesInput,
): WebCaptureDiff["dimensions"] => {
  const before = input.before.inspection;
  const after = input.after.inspection;
  return {
    dom_structure: compareDimension(
      singleton("document", digestCanonicalValue(domProjection(before))),
      singleton("document", digestCanonicalValue(domProjection(after))),
      sectionsComplete(before, ["frames", "dom"]) &&
        sectionsComplete(after, ["frames", "dom"]),
      "DOM or frame capture was incomplete in at least one observation.",
    ),
    scripts: compareDimension(
      keyed(
        before.scripts.items.map(scriptProjection),
        (item) => item.script_key,
      ),
      keyed(
        after.scripts.items.map(scriptProjection),
        (item) => item.script_key,
      ),
      sectionsComplete(before, ["scripts"]) &&
        sectionsComplete(after, ["scripts"]),
      "Script inventory was incomplete in at least one observation.",
    ),
    resources: compareDimension(
      keyed(before.resources, (item) => item.resource_key),
      keyed(after.resources, (item) => item.resource_key),
      sectionsComplete(before, ["resources"]) &&
        sectionsComplete(after, ["resources"]),
      "Resource inventory was incomplete in at least one observation.",
    ),
    network: networkDimension(before, after),
    metadata: compareDimension(
      singleton("metadata", digestCanonicalValue(metadataProjection(before))),
      singleton("metadata", digestCanonicalValue(metadataProjection(after))),
      sectionsComplete(before, ["metadata"]) &&
        sectionsComplete(after, ["metadata"]),
      "Safe metadata capture was incomplete in at least one observation.",
    ),
    webmcp: compareDimension(
      webMcpMap(input.before.webmcp),
      webMcpMap(input.after.webmcp),
      webMcpComplete(input.before.webmcp) && webMcpComplete(input.after.webmcp),
      "WebMCP discovery was unavailable or incomplete in at least one capture.",
    ),
    accessibility: accessibilityDimension(before, after),
    storage: storageDimension(before, after),
  };
};

const keyed = <T>(
  values: readonly T[],
  identity: (value: T) => string,
): ReadonlyMap<string, string> =>
  new Map(
    values.map((value) => [identity(value), digestCanonicalValue(value)]),
  );

type BodyShapeSources = {
  readonly request: boolean;
  readonly response: boolean;
};

const bodyShapesSelected = (inspection: WebPageInspection): boolean =>
  !inspection.completeness.excluded.some(
    ({ section, reason }) =>
      section === "json_body_shapes" && reason === "not_approved",
  ) &&
  (inspection.network.requests.length === 0 ||
    inspection.network.requests.some(
      ({ body_shapes }) => body_shapes.status !== "not_approved",
    ));

const networkIdentity = (
  request: WebPageInspection["network"]["requests"][number],
): string =>
  `net_${digestCanonicalValue({ method: request.method, url: request.url, resource_type: request.resource_type })}`;

const networkDimension = (
  before: WebPageInspection,
  after: WebPageInspection,
): Dimension => {
  const selected = bodyShapesSelected(before) && bodyShapesSelected(after);
  const sources = new Map<string, BodyShapeSources>();
  if (selected) {
    const observedSources = (inspection: WebPageInspection) => {
      const result = new Map<string, BodyShapeSources>();
      for (const request of inspection.network.requests) {
        const identity = networkIdentity(request);
        const previous = result.get(identity);
        result.set(identity, {
          request:
            previous?.request !== false && request.body_shapes.request !== null,
          response:
            previous?.response !== false &&
            request.body_shapes.response !== null,
        });
      }
      return result;
    };
    const left = observedSources(before);
    const right = observedSources(after);
    for (const [identity, coverage] of left) {
      const next = right.get(identity);
      sources.set(identity, {
        request: coverage.request && next?.request === true,
        response: coverage.response && next?.response === true,
      });
    }
  }
  const shapesComplete =
    !selected ||
    [before, after].every(
      (inspection) =>
        sectionsComplete(inspection, ["json_body_shapes"]) &&
        inspection.network.requests.every(
          ({ body_shapes }) => body_shapes.status === "included",
        ),
    );
  return compareDimension(
    networkMap(before, sources),
    networkMap(after, sources),
    sectionsComplete(before, ["network_requests"]) &&
      sectionsComplete(after, ["network_requests"]) &&
      shapesComplete,
    "Network capture or selected JSON body-shape coverage is attach-window limited, unavailable, or incomplete.",
  );
};

const networkMap = (
  inspection: WebPageInspection,
  sources: ReadonlyMap<string, BodyShapeSources>,
): ReadonlyMap<string, string> => {
  const grouped = new Map<string, unknown[]>();
  for (const request of inspection.network.requests) {
    const identity = networkIdentity(request);
    const shapes = sources.get(identity);
    const values = grouped.get(identity) ?? [];
    values.push({
      status: request.status,
      mime_type: request.mime_type,
      encoded_data_length: request.encoded_data_length,
      redirects: (request.redirects ?? []).map(
        ({
          request_timestamp: _requestTimestamp,
          redirect_event_timestamp: _redirectEventTimestamp,
          ...redirect
        }) => redirect,
      ),
      initiator: request.initiator,
      ...(shapes?.request === true
        ? { request_shape: request.body_shapes.request }
        : {}),
      ...(shapes?.response === true
        ? { response_shape: request.body_shapes.response }
        : {}),
    });
    grouped.set(identity, values);
  }
  return new Map(
    [...grouped].map(([identity, values]) => [
      identity,
      digestCanonicalValue(
        values.map((value) => digestCanonicalValue(value)).sort(),
      ),
    ]),
  );
};

const webMcpMap = (
  discovery: WebMcpDiscovery | null,
): ReadonlyMap<string, string> =>
  discovery === null
    ? new Map()
    : keyed(discovery.tools.items, (tool) => tool.tool_key);

const webMcpComplete = (discovery: WebMcpDiscovery | null): boolean =>
  discovery !== null &&
  discovery.status === "available" &&
  !incompleteSections(discovery.completeness).has("webmcp_tools");

const sectionsComplete = (
  inspection: WebPageInspection,
  sections: readonly string[],
): boolean => {
  const incomplete = incompleteSections(inspection.completeness);
  return sections.every((section) => !incomplete.has(section));
};

const incompleteSections = (completeness: {
  readonly policy_filtered_sections: readonly string[];
  readonly attach_limited_sections: readonly string[];
  readonly truncated_sections: readonly string[];
  readonly unavailable_sections: readonly string[];
}): ReadonlySet<string> =>
  new Set([
    ...completeness.policy_filtered_sections,
    ...completeness.attach_limited_sections,
    ...completeness.truncated_sections,
    ...completeness.unavailable_sections,
  ]);

const domProjection = (inspection: WebPageInspection) => ({
  frames: inspection.frames
    .map(({ url, origin }) => ({ url, origin }))
    .sort(
      (left, right) =>
        compareUnicodeCodePoints(left.url, right.url) ||
        compareUnicodeCodePoints(left.origin ?? "", right.origin ?? "") ||
        Number(left.origin !== null) - Number(right.origin !== null),
    ),
  nodes: inspection.dom.nodes.map(({ index: _index, ...node }) => node),
});

const scriptProjection = (
  script: WebPageInspection["scripts"]["items"][number],
) => ({
  script_key: script.script_key,
  url: script.url,
  cdp_hash: script.cdp_hash,
  length: script.length,
  is_module: script.is_module,
  language: script.language,
  source_map_url: script.source_map_url,
});

const metadataProjection = (inspection: WebPageInspection) => ({
  responses: inspection.metadata.responses
    .map(({ request_id: _requestId, ...response }) => response)
    .map((value) => digestCanonicalValue(value))
    .sort(),
  dom_urls: inspection.metadata.dom_urls
    .map((value) => digestCanonicalValue(value))
    .sort(),
  agent_hints: inspection.metadata.agent_hints
    .map((value) => digestCanonicalValue(value))
    .sort(),
  excluded_dom_urls: inspection.metadata.excluded_dom_urls,
  headers_allowlisted: inspection.metadata.headers_allowlisted,
});

const singleton = (key: string, value: string): ReadonlyMap<string, string> =>
  new Map([[key, value]]);

const accessibilityComparable = (
  inspection: WebPageInspection,
): {
  readonly text: boolean;
  readonly nodes: boolean;
  readonly complete: boolean;
} => {
  const text =
    inspection.accessibility.text_capture.status === "included" &&
    inspection.accessibility.text_capture.excluded_fields === 0;
  const nodes =
    inspection.accessibility.total_nodes ===
    inspection.accessibility.nodes.length;
  const complete =
    text && nodes && sectionsComplete(inspection, ["accessibility"]);
  return { text, nodes, complete };
};

const accessibilityProjection = (
  accessibility: WebPageInspection["accessibility"],
  includeText: boolean,
  includeNodes: boolean,
): unknown => {
  if (!includeNodes) return { total_nodes: accessibility.total_nodes };
  const nodeIndexes = new Map(
    accessibility.nodes.map((node, index) => [node.node_id, index]),
  );
  return {
    total_nodes: accessibility.total_nodes,
    nodes: accessibility.nodes.map((node) => ({
      parent_index:
        node.parent_id === null
          ? null
          : (nodeIndexes.get(node.parent_id) ?? -1),
      role: node.role,
      ignored: node.ignored,
      states: node.states,
      ...(includeText
        ? { name: node.name, description: node.description }
        : {}),
    })),
  };
};

const storageKeysComparable = (inspection: WebPageInspection): boolean =>
  sectionsComplete(inspection, ["storage_keys"]);

const storageComparable = (
  before: WebPageInspection,
  after: WebPageInspection,
  keysComplete: boolean,
  usageComplete: boolean,
): boolean =>
  keysComplete &&
  usageComplete &&
  before.storage.fingerprints_complete &&
  after.storage.fingerprints_complete;

const storageMap = (
  storage: WebPageInspection["storage"],
  includeKeys: boolean,
  includeUsage: boolean,
  fingerprintIdentities: ReadonlySet<string>,
): ReadonlyMap<string, string> => {
  const map = new Map<string, string>([
    [
      "storage:summary",
      digestCanonicalValue({
        origin: storage.origin,
        values_redacted: storage.values_redacted,
        ...(includeUsage
          ? {
              usage_bytes: storage.usage_bytes,
              quota_bytes: storage.quota_bytes,
            }
          : {}),
      }),
    ],
  ]);
  if (!includeKeys) return map;
  const add = (kind: string, keys: readonly string[]) => {
    for (const key of keys) {
      map.set(`storage:${kind}:${key}`, digestCanonicalValue(key));
    }
  };
  add("local_storage", storage.local_storage_keys);
  add("session_storage", storage.session_storage_keys);
  add("indexed_db", storage.indexed_db_names);
  add("cache", storage.cache_names);
  for (const fingerprint of storage.content_fingerprints) {
    const identity = `${fingerprint.scope}:${fingerprint.identity_sha256}`;
    if (!fingerprintIdentities.has(identity)) continue;
    map.set(
      `storage:content:${identity}`,
      digestCanonicalValue(fingerprint.value_sha256),
    );
  }
  return map;
};

const storageFingerprintIdentities = (
  before: WebPageInspection["storage"],
  after: WebPageInspection["storage"],
): ReadonlySet<string> => {
  const beforeComplete = completeStorageFingerprints(before);
  const afterComplete = completeStorageFingerprints(after);
  if (before.fingerprints_complete && after.fingerprints_complete)
    return new Set([...beforeComplete.keys(), ...afterComplete.keys()]);
  return new Set(
    [...beforeComplete.keys()].filter((identity) =>
      afterComplete.has(identity),
    ),
  );
};

const completeStorageFingerprints = (
  storage: WebPageInspection["storage"],
): ReadonlyMap<string, string | null> =>
  new Map(
    storage.content_fingerprints
      .filter(({ complete }) => complete)
      .map(({ scope, identity_sha256, value_sha256 }) => [
        `${scope}:${identity_sha256}`,
        value_sha256,
      ]),
  );
