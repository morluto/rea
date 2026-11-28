import { z } from "zod";

import {
  webExecutionObservationSchema,
  type WebExecutionObservation,
} from "../webExecution.js";
import { webRuntimeSourceMetadataSchema } from "../webRuntime.js";
import { ok } from "../result.js";
import { invalidAnalysisView } from "./analysisViewErrors.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  boundedViewLimitations,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import {
  analysisTextPage,
  analysisTextPageItemSchema,
} from "./analysisViewText.js";
import { selectViewRows, filterSet } from "./selectViewRows.js";

export const WEB_EXECUTION_OPERATION = "observe_web_execution" as const;

const shape = webExecutionObservationSchema.shape;
const coverageScriptSchema = shape.coverage.shape.scripts.element;
const functionSchema = coverageScriptSchema.shape.functions.element;
const requestSchema = shape.requests.element;
const sourceSchema = shape.sources.element;

const pageShape = {
  kind: z.literal("web-execution"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().max(512).default(64),
};
const names = z.array(z.string().min(1)).max(64).optional();

/** A function row with the coverage script that reported it. */
const webExecutionFunctionRowSchema = functionSchema.extend({
  script_id: coverageScriptSchema.shape.script_id,
  reported_url: coverageScriptSchema.shape.reported_url,
  function_index: z.int().nonnegative(),
});

/** Source metadata without the captured text, which pages separately. */
const webExecutionSourceRowSchema = sourceSchema.extend({
  source: webRuntimeSourceMetadataSchema,
});

/** The retained collection owns both its selector and its projected rows. */
export const webExecutionCollections = {
  functions: {
    view: z.strictObject({
      ...pageShape,
      collection: z.literal("functions"),
      script_ids: names.describe("Exact session script IDs"),
      executed_only: z
        .boolean()
        .default(false)
        .describe("Only functions with at least one range count above zero"),
    }),
    items: z.array(webExecutionFunctionRowSchema),
  },
  requests: {
    view: z.strictObject({
      ...pageShape,
      collection: z.literal("requests"),
      methods: names.describe("Exact request methods, such as GET"),
    }),
    items: z.array(requestSchema),
  },
  sources: {
    view: z.strictObject({
      ...pageShape,
      collection: z.literal("sources"),
      script_ids: names.describe("Exact session script IDs"),
    }),
    items: z.array(webExecutionSourceRowSchema),
  },
  "source-text": {
    view: z.strictObject({
      kind: z.literal("web-execution"),
      collection: z.literal("source-text"),
      script_id: sourceSchema.shape.script_id,
      offset: z
        .int()
        .nonnegative()
        .default(0)
        .describe("UTF-16 code-unit offset into the captured source"),
      limit: z.int().positive().max(65_536).default(16_384),
    }),
    items: z.array(
      analysisTextPageItemSchema.extend({
        script_id: sourceSchema.shape.script_id,
      }),
    ),
  },
};

/** Pages of one retained observe_web_execution observation. */
export const webExecutionViewRequestSchema = z.discriminatedUnion(
  "collection",
  [
    webExecutionCollections.functions.view,
    webExecutionCollections.requests.view,
    webExecutionCollections.sources.view,
    webExecutionCollections["source-text"].view,
  ],
);
type WebExecutionView = z.output<typeof webExecutionViewRequestSchema>;

export const webExecutionSummarySchema = z.strictObject({
  browser: shape.browser,
  target: shape.target,
  window: shape.window,
  instrumentation: shape.instrumentation,
  script_inventory: shape.script_inventory.omit({
    not_reported_script_ids: true,
  }),
  excluded_requests: shape.excluded_requests,
  coverage: shape.coverage.omit({ scripts: true }),
  counts: z.strictObject({
    coverage_scripts: z.int().nonnegative(),
    functions: z.int().nonnegative(),
    executed_functions: z.int().nonnegative(),
    requests: z.int().nonnegative(),
    sources: z.int().nonnegative(),
    not_reported_scripts: z.int().nonnegative(),
    captured_source_utf16_units: z.int().nonnegative(),
  }),
});

const readReport = createAnalysisViewResultReader(
  webExecutionObservationSchema,
);

type FunctionRow = z.output<typeof webExecutionFunctionRowSchema>;
type Source = WebExecutionObservation["sources"][number];

const executed = (row: { readonly ranges: readonly { count: number }[] }) =>
  row.ranges.some((range) => range.count > 0);

/**
 * One page of function rows in coverage order, with the total that match.
 * Only returned rows are built, so a small page of a large capture stays small.
 */
const selectFunctionRows = (
  report: WebExecutionObservation,
  view: Extract<WebExecutionView, { collection: "functions" }>,
): { rows: FunctionRow[]; total: number } => {
  const ids = filterSet(view.script_ids);
  const rows: FunctionRow[] = [];
  let total = 0;
  for (const script of report.coverage.scripts) {
    if (ids !== undefined && !ids.has(script.script_id)) continue;
    for (let index = 0; index < script.functions.length; index += 1) {
      const fn = script.functions[index]!;
      if (view.executed_only && !executed(fn)) continue;
      if (total >= view.offset && rows.length < view.limit)
        rows.push({
          ...fn,
          script_id: script.script_id,
          reported_url: script.reported_url,
          function_index: index,
        });
      total++;
    }
  }
  return { rows, total };
};

const sourceRow = (
  row: Source,
): z.output<typeof webExecutionSourceRowSchema> => {
  const { source, ...metadata } = row;
  return {
    ...metadata,
    source:
      source.state === "captured"
        ? {
            state: "captured",
            sha256: source.sha256,
            utf8_bytes: source.utf8_bytes,
            utf16_units: source.utf16_units,
          }
        : { state: source.state, reason: source.reason },
  };
};

const summarize = (
  report: WebExecutionObservation,
): z.output<typeof webExecutionSummarySchema> => {
  let functions = 0;
  let executedFunctions = 0;
  for (const script of report.coverage.scripts) {
    functions += script.functions.length;
    for (const fn of script.functions) if (executed(fn)) executedFunctions++;
  }
  const { scripts: _scripts, ...coverage } = report.coverage;
  const { not_reported_script_ids: notReported, ...scriptInventory } =
    report.script_inventory;
  return {
    browser: report.browser,
    target: report.target,
    window: report.window,
    instrumentation: report.instrumentation,
    script_inventory: scriptInventory,
    excluded_requests: report.excluded_requests,
    coverage,
    counts: {
      coverage_scripts: report.coverage.scripts.length,
      functions,
      executed_functions: executedFunctions,
      requests: report.requests.length,
      sources: report.sources.length,
      not_reported_scripts: notReported.length,
      captured_source_utf16_units: report.sources.reduce(
        (total, row) =>
          total +
          (row.source.state === "captured" ? row.source.utf16_units : 0),
        0,
      ),
    },
  };
};

/**
 * Context every page keeps: the coverage state and script inventory, so a
 * short page still says whether coverage or sources were available.
 */
const pageContextOf = (report: WebExecutionObservation) => {
  const { scripts: _coverageScripts, ...coverageContext } = report.coverage;
  return {
    coverage_context: coverageContext,
    script_inventory: {
      main_document_scripts: report.script_inventory.main_document_scripts,
      not_reported_scripts:
        report.script_inventory.not_reported_script_ids.length,
      coverage_absence: report.script_inventory.coverage_absence,
    },
  };
};

/** One UTF-16 page of a captured script source, or why it has none. */
const sourceTextPage = (
  report: WebExecutionObservation,
  view: Extract<WebExecutionView, { collection: "source-text" }>,
) => {
  const captured = report.sources.find(
    (row) => row.script_id === view.script_id,
  )?.source;
  if (captured?.state !== "captured")
    return invalidAnalysisView(
      captured === undefined
        ? "No source with this script_id was observed; list sources first."
        : `Source text was not captured: ${captured.reason}`,
      "script_id",
    );
  return analysisTextPage(captured.text, view.offset, view.limit, "Source");
};

/** Project a retained execution observation's summary or one page. */
export const projectWebExecutionView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  if (admitted.kind !== "web-execution" && admitted.kind !== "summary")
    return invalidAnalysisView(
      "Select a web-execution or summary view.",
      "kind",
    );
  assertOwnedView<SummaryAnalysisView | WebExecutionView>(
    admitted,
    "summary",
    "web-execution",
  );
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: WEB_EXECUTION_OPERATION,
    parent_digest: parent.evidenceId.slice(3),
    artifact: parent.artifact ?? null,
    target_url: report.target.initial_url,
    limitations: boundedViewLimitations(parent, report.limitations),
    unknowns: [
      "Execution outside the armed window, in workers, or caused by UI actions remains unknown.",
    ],
  };
  if (admitted.kind === "summary")
    return ok({
      ...shared,
      kind: "summary" as const,
      view: admitted,
      summary: summarize(report),
      coverage: completeWithinViewCoverage(1),
    });
  const view = admitted;
  const pageContext = { ...shared, ...pageContextOf(report) };
  const page = <View extends WebExecutionView, Row>(
    selection: View,
    items: Row[],
    total: number,
  ) =>
    ok({
      ...pageContext,
      kind: "web-execution" as const,
      view: selection,
      items,
      coverage: pageViewCoverage(selection.offset, items.length, total),
    });
  switch (view.collection) {
    case "functions": {
      const rows = selectFunctionRows(report, view);
      return page(view, rows.rows, rows.total);
    }
    case "requests": {
      const methods = filterSet(view.methods);
      const rows = selectViewRows(
        report.requests,
        view,
        methods === undefined ? undefined : (row) => methods.has(row.method),
        (row) => row,
      );
      return page(view, rows.rows, rows.total);
    }
    case "sources": {
      const ids = filterSet(view.script_ids);
      const rows = selectViewRows(
        report.sources,
        view,
        ids === undefined ? undefined : (row) => ids.has(row.script_id),
        sourceRow,
      );
      return page(view, rows.rows, rows.total);
    }
    case "source-text": {
      const text = sourceTextPage(report, view);
      if (!text.ok) return text;
      return ok({
        ...pageContext,
        kind: "web-execution" as const,
        view,
        items: [{ ...text.value.item, script_id: view.script_id }],
        coverage: text.value.coverage,
      });
    }
  }
};
