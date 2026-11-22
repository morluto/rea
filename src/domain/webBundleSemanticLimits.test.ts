import { expect, it } from "vitest";
import { createWebPageInspection } from "../../tests/support/browser/webPageInspection.js";
import type { JavaScriptSemanticPrecisionInput } from "./javascript/javascriptSemanticPrecision.js";
import { analyzeCapturedWebScript } from "./webBundleAnalyzer.js";
import { buildCapturedWebBundleAnalysis } from "./webBundleAnalyzerResult.js";
import { isIncludedScript } from "./webBundleAnalyzerState.js";
import { webBundleScriptAnalysisSchema } from "./webBundleScriptAnalysis.js";

const source =
  "const routes = {get path(){ return '/a'; }}; createBrowserRouter([{path:routes.path}, {path:routes.path}]); fetch('/health');";

const analyze = (
  texts: readonly string[],
  precision: JavaScriptSemanticPrecisionInput,
) => {
  const inspection = createWebPageInspection(
    texts.map((text, index) => ({
      source: text,
      scriptKey: `scr_${String(index + 1).repeat(64)}`,
      url: `https://app.example.test/${String(index)}.js`,
      origin: "https://app.example.test",
      cdpHash: "hash",
    })),
  );
  const results = inspection.scripts.items
    .filter(isIncludedScript)
    .map((script) => analyzeCapturedWebScript(script, precision));
  // Exercise the same strict serializable result boundary the worker uses.
  const transferred = results.map((result) =>
    webBundleScriptAnalysisSchema.parse(JSON.parse(JSON.stringify(result))),
  );
  const report = buildCapturedWebBundleAnalysis(
    inspection,
    {
      status: "not_requested",
      requested: 0,
      processed: 0,
      items: [],
    },
    transferred,
  );
  return { results: transferred, report };
};

it.each(["getter_expansions", "alias_selections"] as const)(
  "retains reached %s facts and actionable recovery without dropping findings",
  (field) => {
    const { results, report } = analyze([source], { [field]: 1 });
    expect(report.completeness).toMatchObject({
      status: "partial",
      parsed_scripts: 1,
      parse_failures: 0,
    });
    expect(report.observations.endpoints.map((entry) => entry.value)).toEqual([
      "/health",
    ]);
    expect(report.unknowns).toEqual([
      {
        dimension: "javascript_analysis",
        reason: expect.stringContaining(`semantic_precision.${field}=1`),
        affected_script_keys: [results[0]!.script_key],
        limit: {
          control_kind: "parameter",
          parameter: `semantic_precision.${field}`,
          effective_value: 1,
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
          default_value: 512,
          unit: "count",
          applies_at: "next_call",
        },
        remediation: `Increase semantic_precision.${field} on the next analysis call.`,
      },
    ]);
  },
);

it("records only reached controls, rather than echoing every selected low budget", () => {
  const { report } = analyze([source], {
    getter_expansions: 1,
    expression_depth: 1,
  });
  expect(
    report.unknowns.map((entry) =>
      entry.limit !== undefined && "parameter" in entry.limit
        ? entry.limit.parameter
        : null,
    ),
  ).toEqual(["semantic_precision.getter_expansions"]);
});

it("clears the limitation when the next analysis has sufficient precision", () => {
  const low = analyze([source], { getter_expansions: 1 });
  const raised = analyze([source], { getter_expansions: 512 });
  expect(low.report.unknowns).toHaveLength(1);
  expect(raised.report.unknowns).toEqual([]);
  expect(raised.report.completeness.status).toBe("complete");
  expect(raised.results[0]).not.toHaveProperty("semantic_limits");
});

it("attributes each reached budget to its own script and preserves unaffected scripts", () => {
  const { results, report } = analyze(
    [source, source, "fetch('/unaffected');"],
    { getter_expansions: 1 },
  );
  expect(report.unknowns.map((entry) => entry.affected_script_keys)).toEqual([
    [results[0]!.script_key],
    [results[1]!.script_key],
  ]);
  // The same endpoint from both limited scripts merges and keeps both scripts.
  expect(report.observations.endpoints).toMatchObject([
    {
      value: "/health",
      occurrences: 2,
      script_keys: [results[0]!.script_key, results[1]!.script_key],
    },
    { value: "/unaffected" },
  ]);
  expect(report.observations.endpoints).toHaveLength(2);
  expect(report.completeness).toMatchObject({
    status: "partial",
    parsed_scripts: 3,
    parse_failures: 0,
  });
  expect(results[2]).not.toHaveProperty("semantic_limits");
});

it("refuses worker results that claim evaluator facts after a failed parse", () => {
  const { results } = analyze([source], { getter_expansions: 1 });
  const result = results[0];
  if (result?.status !== "analyzed")
    throw new Error("Expected script analysis");
  expect(
    webBundleScriptAnalysisSchema.safeParse({
      ...result,
      parse_status: "failed",
      visited_ast_nodes: 0,
      widened_return_references: false,
      route_facts: null,
      observations: {
        edges: [],
        routes: [],
        endpoints: [],
        webmcp_declarations: [],
        unresolved_endpoints: [],
      },
      inferences: [],
    }).success,
  ).toBe(false);
});
