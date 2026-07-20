import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import {
  webPageInspectionSchema,
  type WebPageInspection,
} from "./browserObservation.js";
import {
  webMcpDiscoverySchema,
  type WebMcpDiscovery,
} from "./webMcpDiscovery.js";

const captureSnapshotSchema = z.object({
  inspection: webPageInspectionSchema,
  webmcp: webMcpDiscoverySchema.nullable().default(null),
});

/** Input for deterministic comparison of two normalized web captures. */
export const compareWebCapturesInputSchema = z.object({
  before: captureSnapshotSchema,
  after: captureSnapshotSchema,
  max_changes: z.number().int().min(1).max(20_000).default(2_000),
});
export type CompareWebCapturesInput = z.infer<
  typeof compareWebCapturesInputSchema
>;

const changeSchema = z.object({
  identity: z.string(),
  change: z.enum(["added", "removed", "modified"]),
});
const dimensionSchema = z.object({
  status: z.enum(["changed", "unchanged", "unknown"]),
  total_changes: z.number().int().min(0),
  changes: z.array(changeSchema),
  omitted_changes: z.number().int().min(0),
  reason: z.string().nullable(),
});

/** Completeness-aware changes across stable browser evidence dimensions. */
export const webCaptureDiffSchema = z.object({
  schema_version: z.literal(1),
  overall_status: z.enum(["changed", "unchanged", "unknown"]),
  before_target: z.object({ target_id: z.string(), url: z.string() }),
  after_target: z.object({ target_id: z.string(), url: z.string() }),
  dimensions: z.object({
    dom_structure: dimensionSchema,
    scripts: dimensionSchema,
    resources: dimensionSchema,
    network: dimensionSchema,
    metadata: dimensionSchema,
    accessibility: dimensionSchema,
    storage: dimensionSchema,
    console_errors: dimensionSchema,
    current_route: dimensionSchema,
    lifecycle: dimensionSchema,
    webmcp: dimensionSchema,
  }),
  limitations: z.array(z.string()),
});
export type WebCaptureDiff = z.infer<typeof webCaptureDiffSchema>;
type Dimension =
  WebCaptureDiff["dimensions"][keyof WebCaptureDiff["dimensions"]];
type Change = Dimension["changes"][number];
type DimensionBuilder = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  complete: boolean,
  reason: string,
) => Dimension;

/** Compare normalized observations without treating incomplete absence as proof. */
export const compareWebCaptures = (
  input: CompareWebCapturesInput,
): WebCaptureDiff => {
  const dimension = createDimensionBuilder(input.max_changes);
  const before = input.before.inspection;
  const after = input.after.inspection;
  const dimensions = {
    ...contentDimensions(before, after, dimension),
    ...runtimeDimensions(before, after, dimension),
    webmcp: dimension(
      webMcpMap(input.before.webmcp),
      webMcpMap(input.after.webmcp),
      webMcpComplete(input.before.webmcp) && webMcpComplete(input.after.webmcp),
      "WebMCP discovery was unavailable or incomplete in at least one capture.",
    ),
  };
  const statuses = Object.values(dimensions).map(({ status }) => status);
  return webCaptureDiffSchema.parse({
    schema_version: 1,
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
      "Current-route comparison covers the observed final page URL; complete history alignment requires a session capture.",
    ],
  });
};

const createDimensionBuilder = (maxChanges: number): DimensionBuilder => {
  let remaining = maxChanges;
  return (
    before: ReadonlyMap<string, string>,
    after: ReadonlyMap<string, string>,
    complete: boolean,
    reason: string,
  ): Dimension => {
    const all = compareIdentities(before, after);
    const retained = all.slice(0, remaining);
    remaining -= retained.length;
    return {
      status: all.length > 0 ? "changed" : complete ? "unchanged" : "unknown",
      total_changes: all.length,
      changes: retained,
      omitted_changes: all.length - retained.length,
      reason: all.length === 0 && !complete ? reason : null,
    };
  };
};

const contentDimensions = (
  before: WebPageInspection,
  after: WebPageInspection,
  dimension: DimensionBuilder,
) => ({
  dom_structure: dimension(
    singleton("document", digest(domProjection(before))),
    singleton("document", digest(domProjection(after))),
    sectionsComplete(before, ["frames", "dom"]) &&
      sectionsComplete(after, ["frames", "dom"]),
    "DOM or frame capture was incomplete in at least one observation.",
  ),
  scripts: dimension(
    keyed(
      before.scripts.items.map(scriptProjection),
      (item) => item.script_key,
    ),
    keyed(after.scripts.items.map(scriptProjection), (item) => item.script_key),
    sectionsComplete(before, ["scripts"]) &&
      sectionsComplete(after, ["scripts"]),
    "Script inventory was incomplete in at least one observation.",
  ),
  resources: dimension(
    keyed(before.resources, (item) => item.resource_key),
    keyed(after.resources, (item) => item.resource_key),
    sectionsComplete(before, ["resources"]) &&
      sectionsComplete(after, ["resources"]),
    "Resource inventory was incomplete in at least one observation.",
  ),
  network: dimension(
    networkMap(before),
    networkMap(after),
    sectionsComplete(before, ["network_requests"]) &&
      sectionsComplete(after, ["network_requests"]),
    "Network capture is attach-window limited or incomplete.",
  ),
  metadata: dimension(
    singleton("metadata", digest(metadataProjection(before))),
    singleton("metadata", digest(metadataProjection(after))),
    sectionsComplete(before, ["metadata"]) &&
      sectionsComplete(after, ["metadata"]),
    "Safe metadata capture was incomplete in at least one observation.",
  ),
});

const runtimeDimensions = (
  before: WebPageInspection,
  after: WebPageInspection,
  dimension: DimensionBuilder,
) => ({
  accessibility: dimension(
    singleton("accessibility", digest(accessibilityProjection(before))),
    singleton("accessibility", digest(accessibilityProjection(after))),
    sectionsComplete(before, ["accessibility"]) &&
      sectionsComplete(after, ["accessibility"]),
    "Accessibility capture was unavailable or incomplete in at least one observation.",
  ),
  storage: dimension(
    singleton("storage", digest(storageProjection(before))),
    singleton("storage", digest(storageProjection(after))),
    sectionsComplete(before, ["storage", "storage_keys"]) &&
      sectionsComplete(after, ["storage", "storage_keys"]),
    "Storage capture was unavailable or incomplete in at least one observation.",
  ),
  console_errors: dimension(
    consoleErrorMap(before),
    consoleErrorMap(after),
    sectionsComplete(before, ["console_events"]) &&
      sectionsComplete(after, ["console_events"]),
    "Console-event capture is attach-window limited or incomplete.",
  ),
  current_route: dimension(
    singleton("route", digest(before.target.url)),
    singleton("route", digest(after.target.url)),
    true,
    "",
  ),
  lifecycle: dimension(
    singleton("lifecycle", digest(lifecycleProjection(before))),
    singleton("lifecycle", digest(lifecycleProjection(after))),
    sectionsComplete(before, ["frames", "workers"]) &&
      sectionsComplete(after, ["frames", "workers"]),
    "Frame or worker lifecycle capture was unavailable or incomplete.",
  ),
});

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
      left.identity.localeCompare(right.identity) ||
      left.change.localeCompare(right.change),
  );
};

const keyed = <T>(
  values: readonly T[],
  identity: (value: T) => string,
): ReadonlyMap<string, string> =>
  new Map(values.map((value) => [identity(value), digest(value)]));

const networkMap = (
  inspection: WebPageInspection,
): ReadonlyMap<string, string> => {
  const grouped = new Map<string, unknown[]>();
  for (const request of inspection.network.requests) {
    const identity = `net_${digest({
      method: request.method,
      url: request.url,
      resource_type: request.resource_type,
    })}`;
    const values = grouped.get(identity) ?? [];
    values.push({
      status: request.status,
      mime_type: request.mime_type,
      encoded_data_length: request.encoded_data_length,
      initiator: request.initiator,
      body_shapes: request.body_shapes,
    });
    grouped.set(identity, values);
  }
  return new Map(
    [...grouped].map(([identity, values]) => [
      identity,
      digest(values.map((value) => digest(value)).sort()),
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
    .sort((left, right) => left.url.localeCompare(right.url)),
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
    .map((value) => digest(value))
    .sort(),
  dom_urls: inspection.metadata.dom_urls.map((value) => digest(value)).sort(),
  agent_hints: inspection.metadata.agent_hints
    .map((value) => digest(value))
    .sort(),
  excluded_dom_urls: inspection.metadata.excluded_dom_urls,
  headers_allowlisted: inspection.metadata.headers_allowlisted,
});

const accessibilityProjection = (inspection: WebPageInspection) => {
  const indexById = new Map(
    inspection.accessibility.nodes.map(({ node_id: id }, index) => [id, index]),
  );
  return {
    total_nodes: inspection.accessibility.total_nodes,
    text_capture: inspection.accessibility.text_capture,
    nodes: inspection.accessibility.nodes.map(
      ({ node_id: _nodeId, parent_id: parentId, ...node }) => ({
        ...node,
        parent_index:
          parentId === null ? null : (indexById.get(parentId) ?? -1),
      }),
    ),
  };
};

const storageProjection = (inspection: WebPageInspection) => ({
  ...inspection.storage,
  local_storage_keys: [...inspection.storage.local_storage_keys].sort(),
  session_storage_keys: [...inspection.storage.session_storage_keys].sort(),
  indexed_db_names: [...inspection.storage.indexed_db_names].sort(),
  cache_names: [...inspection.storage.cache_names].sort(),
});

const consoleErrorMap = (
  inspection: WebPageInspection,
): ReadonlyMap<string, string> => {
  const errors = inspection.console.events
    .filter(({ type }) => type === "error" || type === "assert")
    .map(({ timestamp: _timestamp, ...event }) => event);
  const counts = new Map<string, number>();
  for (const error of errors) {
    const fingerprint = digest(error);
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }
  return new Map(
    [...counts].map(([fingerprint, count]) => [fingerprint, String(count)]),
  );
};

const lifecycleProjection = (inspection: WebPageInspection) => ({
  frames: inspection.frames
    .map(
      ({ frame_id: _frameId, parent_frame_id: _parentFrameId, ...frame }) =>
        frame,
    )
    .map((frame) => digest(frame))
    .sort(),
  workers: inspection.workers
    .map(
      ({
        target_id: _targetId,
        opener_target_id: _openerTargetId,
        parent_frame_id: _parentFrameId,
        ...worker
      }) => worker,
    )
    .map((worker) => digest(worker))
    .sort(),
});

const singleton = (key: string, value: string): ReadonlyMap<string, string> =>
  new Map([[key, value]]);

const digest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new TypeError("Expected canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};
