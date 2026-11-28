import { z } from "zod";

import {
  webPageInspectionSchema,
  type WebPageInspection,
} from "../browserObservationSchemas.js";
import { ok } from "../result.js";
import { invalidAnalysisView } from "./analysisViewErrors.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  boundedViewLimitations,
  completeWithinViewCoverage,
  selectedViewPage,
} from "./analysisViewCoverage.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { selectViewRows } from "./selectViewRows.js";
import {
  analysisTextPage,
  analysisTextPageItemSchema,
} from "./analysisViewText.js";
import { webTextArtifactMetadataSchema } from "../webContentArtifact.js";

export const WEB_PAGE_OPERATION = "inspect_web_page" as const;

const page = webPageInspectionSchema.shape;
const domNodeSchema = page.dom.shape.nodes.element;
const accessibilityNodeSchema = page.accessibility.shape.nodes.element;
const consoleEventSchema = page.console.shape.events.element;
const networkRequestSchema = page.network.shape.requests.element;
const scriptSchema = page.scripts.shape.items.element;
const resourceSchema = page.resources.element;
const frameSchema = page.frames.element;
const workerSchema = page.workers.element;

/** Script metadata; captured text pages through the script-source collection. */
export const webPageScriptRowSchema = scriptSchema
  .omit({ source: true })
  .extend({
    source: z.discriminatedUnion("included", [
      z.strictObject({ included: z.literal(false), reason: z.string() }),
      z.strictObject({
        included: z.literal(true),
        artifact: webTextArtifactMetadataSchema,
      }),
    ]),
  });

/** The selected section's own capture context, beside the page's coverage. */
export const webPageSectionSchema = z.strictObject({
  dom: page.dom.omit({ nodes: true }).optional(),
  accessibility: page.accessibility.omit({ nodes: true }).optional(),
  console: page.console.omit({ events: true }).optional(),
  network: page.network
    .omit({ requests: true, websocket_connections: true })
    .optional(),
  scripts: page.scripts.omit({ items: true }).optional(),
});

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
  z.strictObject({
    kind: z.literal("web-page"),
    collection: z.literal("script-source"),
    script_key: scriptSchema.shape.script_key,
    offset: z
      .int()
      .nonnegative()
      .default(0)
      .describe("UTF-16 code-unit offset into the captured source"),
    limit: z.int().positive().max(65_536).default(16_384),
  }),
  z.strictObject({ ...pageShape, collection: z.literal("resources") }),
  z.strictObject({ ...pageShape, collection: z.literal("frames") }),
  z.strictObject({ ...pageShape, collection: z.literal("workers") }),
]);
type WebPageView = z.output<typeof webPageViewRequestSchema>;

/** The capture's small context with counts in place of its paged collections. */
export const webPageSummarySchema = z.strictObject({
  browser: page.browser,
  target: page.target,
  capture_window: page.capture_window,
  completeness: page.completeness,
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
    frames: z.int().nonnegative(),
    workers: z.int().nonnegative(),
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
  z.array(webPageScriptRowSchema),
  z.array(resourceSchema),
  z.array(frameSchema),
  z.array(workerSchema),
  z.array(analysisTextPageItemSchema.extend({ script_key: z.string() })),
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
      frames: report.frames.length,
      workers: report.workers.length,
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

type Script = WebPageInspection["scripts"]["items"][number];
const scriptRow = ({
  source,
  ...metadata
}: Script): z.output<typeof webPageScriptRowSchema> => {
  if (!source.included) return { ...metadata, source };
  const { text: _text, ...artifact } = source.artifact;
  return { ...metadata, source: { included: true, artifact } };
};

const sectionOf = (
  report: WebPageInspection,
  collection: Exclude<WebPageView["collection"], "script-source">,
): z.output<typeof webPageSectionSchema> => {
  switch (collection) {
    case "dom": {
      const { nodes: _nodes, ...dom } = report.dom;
      return { dom };
    }
    case "accessibility": {
      const { nodes: _nodes, ...accessibility } = report.accessibility;
      return { accessibility };
    }
    case "console": {
      const { events: _events, ...context } = report.console;
      return { console: context };
    }
    case "network": {
      const {
        requests: _requests,
        websocket_connections: _sockets,
        ...network
      } = report.network;
      return { network };
    }
    case "scripts": {
      const { items: _items, ...scripts } = report.scripts;
      return { scripts };
    }
    default:
      return {};
  }
};

const selectRows = (
  report: WebPageInspection,
  view: Exclude<WebPageView, { collection: "script-source" }>,
) => {
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
      return selectViewRows(report.scripts.items, view, undefined, scriptRow);
    case "resources":
      return selectViewRows(report.resources, view, undefined, identity);
    case "frames":
      return selectViewRows(report.frames, view, undefined, identity);
    case "workers":
      return selectViewRows(report.workers, view, undefined, identity);
  }
};

/** Project a retained page capture's summary or one page of a collection. */
export const projectWebPageView = (
  parent: AnalysisViewParent,
  selected: AdmittedView,
) => {
  if (selected.kind !== "web-page" && selected.kind !== "summary")
    return invalidAnalysisView("Select a web-page or summary view.", "kind");
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
    limitations: boundedViewLimitations(parent),
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
  // Every page keeps the capture's completeness and its section's context,
  // so an empty or short page still says whether the section was observed.
  const context = { ...shared, completeness: report.completeness };
  if (selected.collection === "script-source") {
    const script = report.scripts.items.find(
      (row) => row.script_key === selected.script_key,
    );
    const source = script?.source;
    if (source?.included !== true)
      return invalidAnalysisView(
        source === undefined
          ? "No script with this script_key was captured; list scripts first."
          : `Script source was not captured: ${source.reason}`,
        "script_key",
      );
    const text = analysisTextPage(
      source.artifact.text,
      selected.offset,
      selected.limit,
      "Script source",
    );
    if (!text.ok) return text;
    return ok({
      ...context,
      kind: "web-page" as const,
      view: selected,
      section: { scripts: { total: report.scripts.total } },
      items: [{ ...text.value.item, script_key: selected.script_key }],
      coverage: text.value.coverage,
    });
  }
  const rows = selectRows(report, selected);
  return ok({
    ...context,
    kind: "web-page" as const,
    view: selected,
    section: sectionOf(report, selected.collection),
    ...selectedViewPage(selected.offset, rows),
  });
};
