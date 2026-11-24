import { z } from "zod";

import {
  webPageInspectionSchema,
  type WebPageInspection,
} from "../browserObservationSchemas.js";
import { err, ok } from "../result.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { selectViewRows } from "./selectViewRows.js";

export const WEB_PAGE_OPERATION = "inspect_web_page" as const;

const page = webPageInspectionSchema.shape;
const domNodeSchema = page.dom.shape.nodes.element;
const accessibilityNodeSchema = page.accessibility.shape.nodes.element;
const consoleEventSchema = page.console.shape.events.element;
const networkRequestSchema = page.network.shape.requests.element;
const scriptSchema = page.scripts.shape.items.element;
const resourceSchema = page.resources.element;

const pageShape = {
  kind: z.literal("web-page"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().max(512).default(64),
};
const names = z.array(z.string().min(1)).max(64).optional();

/** Pages of one retained inspect_web_page capture. Filters match exactly. */
export const webPageViewRequestSchema = z.discriminatedUnion("collection", [
  z.strictObject({
    ...pageShape,
    collection: z.literal("dom"),
    node_names: names.describe(
      "Exact DOM node names as recorded, such as BUTTON or #text",
    ),
  }),
  z.strictObject({
    ...pageShape,
    collection: z.literal("accessibility"),
    roles: names.describe("Exact accessibility roles, such as button or link"),
  }),
  z.strictObject({
    ...pageShape,
    collection: z.literal("console"),
    types: names.describe("Exact console event types, such as log or error"),
  }),
  z.strictObject({
    ...pageShape,
    collection: z.literal("network"),
    methods: names.describe("Exact request methods, such as GET"),
  }),
  z.strictObject({ ...pageShape, collection: z.literal("scripts") }),
  z.strictObject({ ...pageShape, collection: z.literal("resources") }),
]);
type WebPageView = z.output<typeof webPageViewRequestSchema>;

/** The capture's small context with counts in place of its paged collections. */
export const webPageSummarySchema = z.strictObject({
  browser: page.browser,
  target: page.target,
  capture_window: page.capture_window,
  completeness: page.completeness,
  frames: page.frames,
  workers: page.workers,
  dom: page.dom.omit({ nodes: true }),
  accessibility: page.accessibility.omit({ nodes: true }),
  network: page.network.omit({ requests: true, websocket_connections: true }),
  console: page.console.omit({ events: true }),
  storage: page.storage.pick({
    origin: true,
    usage_bytes: true,
    quota_bytes: true,
  }),
  counts: z.strictObject({
    dom_nodes: z.int().nonnegative(),
    accessibility_nodes: z.int().nonnegative(),
    console_events: z.int().nonnegative(),
    console_events_by_type: z.record(z.string(), z.int().nonnegative()),
    network_requests: z.int().nonnegative(),
    websocket_connections: z.int().nonnegative(),
    scripts: z.int().nonnegative(),
    resources: z.int().nonnegative(),
    metadata_responses: z.int().nonnegative(),
    agent_hints: z.int().nonnegative(),
    metadata_dom_urls: z.int().nonnegative(),
    storage_keys: z.int().nonnegative(),
    storage_fingerprints: z.int().nonnegative(),
  }),
});
type WebPageSummary = z.output<typeof webPageSummarySchema>;

export const webPageViewItemsSchema = z.union([
  z.array(domNodeSchema),
  z.array(accessibilityNodeSchema),
  z.array(consoleEventSchema),
  z.array(networkRequestSchema),
  z.array(scriptSchema),
  z.array(resourceSchema),
]);

const readReport = createAnalysisViewResultReader(webPageInspectionSchema);

const summarize = (report: WebPageInspection): WebPageSummary => {
  const byType: Record<string, number> = {};
  for (const event of report.console.events)
    byType[event.type] = (byType[event.type] ?? 0) + 1;
  const { nodes: _dom, ...dom } = report.dom;
  const { nodes: _accessibility, ...accessibility } = report.accessibility;
  const {
    requests: _requests,
    websocket_connections: _sockets,
    ...network
  } = report.network;
  const { events: _events, ...consoleContext } = report.console;
  return {
    browser: report.browser,
    target: report.target,
    capture_window: report.capture_window,
    completeness: report.completeness,
    frames: report.frames,
    workers: report.workers,
    dom,
    accessibility,
    network,
    console: consoleContext,
    storage: {
      origin: report.storage.origin,
      usage_bytes: report.storage.usage_bytes,
      quota_bytes: report.storage.quota_bytes,
    },
    counts: {
      dom_nodes: report.dom.nodes.length,
      accessibility_nodes: report.accessibility.nodes.length,
      console_events: report.console.events.length,
      console_events_by_type: byType,
      network_requests: report.network.requests.length,
      websocket_connections: report.network.websocket_connections.length,
      scripts: report.scripts.items.length,
      resources: report.resources.length,
      metadata_responses: report.metadata.responses.length,
      agent_hints: report.metadata.agent_hints.length,
      metadata_dom_urls: report.metadata.dom_urls.length,
      storage_keys:
        report.storage.local_storage_keys.length +
        report.storage.session_storage_keys.length,
      storage_fingerprints: report.storage.content_fingerprints.length,
    },
  };
};

const matching = <Row>(
  selected: readonly string[] | undefined,
  value: (row: Row) => string | null,
): ((row: Row) => boolean) | undefined => {
  if (selected === undefined) return undefined;
  const wanted = new Set(selected);
  return (row) => {
    const recorded = value(row);
    return recorded !== null && wanted.has(recorded);
  };
};

const identity = <Row>(row: Row): Row => row;

const selectRows = (report: WebPageInspection, view: WebPageView) => {
  switch (view.collection) {
    case "dom":
      return selectViewRows(
        report.dom.nodes,
        view,
        matching(view.node_names, (row) => row.node_name),
        identity,
      );
    case "accessibility":
      return selectViewRows(
        report.accessibility.nodes,
        view,
        matching(view.roles, (row) => row.role),
        identity,
      );
    case "console":
      return selectViewRows(
        report.console.events,
        view,
        matching(view.types, (row) => row.type),
        identity,
      );
    case "network":
      return selectViewRows(
        report.network.requests,
        view,
        matching(view.methods, (row) => row.method),
        identity,
      );
    case "scripts":
      return selectViewRows(report.scripts.items, view, undefined, identity);
    case "resources":
      return selectViewRows(report.resources, view, undefined, identity);
  }
};

/** Project a retained page capture's summary or one page of a collection. */
export const projectWebPageView = (
  parent: AnalysisViewParent,
  selected: AdmittedView,
) => {
  if (selected.kind !== "web-page" && selected.kind !== "summary")
    return err(
      analysisViewInputError([
        {
          path: ["view", "kind"],
          reason: "invalid_value",
          message: "Select a web-page or summary view.",
        },
      ]),
    );
  assertOwnedView<SummaryAnalysisView | WebPageView>(
    selected,
    "summary",
    "web-page",
  );
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: WEB_PAGE_OPERATION,
    parent_digest: parent.evidenceId.slice(3),
    artifact: parent.artifact ?? null,
    target_url: report.target.url,
    limitations: boundedViewMessages(
      parent.limitations,
      parent.evidenceId,
      "limitations",
    ),
    unknowns: [
      "Activity before the capture attached is not recorded; network and console coverage start at their coverage_started_at.",
    ],
  };
  if (selected.kind === "summary")
    return ok({
      ...shared,
      kind: "summary" as const,
      view: selected,
      summary: summarize(report),
      coverage: completeWithinViewCoverage(1),
    });
  const rows = selectRows(report, selected);
  return ok({
    ...shared,
    kind: "web-page" as const,
    view: selected,
    items: rows.rows,
    coverage: pageViewCoverage(selected.offset, rows.rows.length, rows.total),
  });
};
