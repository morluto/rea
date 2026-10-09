import {
  AnalysisInputError,
  type AnalysisInputIssue,
} from "../analysisErrorCore.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { uniqueSorted } from "../canonicalOrdering.js";
import { jsonObjectSchema, type JsonValue } from "../jsonValue.js";
import type { JavaScriptApplicationAnalysisResult } from "../javascript/javascriptApplicationAnalysis.js";
import type { ApplicationNode } from "../javascript/javascriptApplicationGraphSchemas.js";
import { err, ok, type Result } from "../result.js";
import type {
  AnalysisViewCoverage,
  AnalysisViewParent,
  AnalysisViewRequest,
  UnsignedAnalysisView,
} from "./analysisView.js";

const OPERATION = "inspect_analysis_view";
const SOURCE_TEXT_KEYS = new Set([
  "source",
  "text",
  "source_text",
  "sourceText",
  "contents",
  "code",
]);

const inputError = (
  issues: readonly AnalysisInputIssue[],
): AnalysisInputError => new AnalysisInputError(OPERATION, undefined, issues);

const completeCoverage = (
  examined: number,
  total: number,
): AnalysisViewCoverage => ({
  status: "complete-within-view",
  examined,
  total,
  next_offset: null,
  exhausted: true,
});

const pageCoverage = (
  offset: number,
  examined: number,
  total: number,
): AnalysisViewCoverage => {
  const exhausted = offset >= total || offset + examined >= total;
  return {
    status: examined === 0 ? "empty" : "page",
    examined,
    total,
    next_offset: exhausted ? null : offset + examined,
    exhausted,
  };
};

const jsIncompatible = (detail: string): AnalysisError =>
  inputError([
    {
      path: ["view"],
      reason: "invalid_value",
      message: detail,
    },
  ]);

/** Artifact-relative path used to select a module when one exists. */
export const javascriptModulePath = (node: ApplicationNode): string | null => {
  if (node.identity.strategy === "canonical-path") return node.identity.path;
  for (const observation of node.observations) {
    const path = observation.properties.path;
    if (typeof path === "string" && path.length > 0) return path;
    const location = observation.evidence.location;
    if (location.available && location.value.kind === "artifact-path")
      return location.value.path;
  }
  return null;
};

const moduleEntries = (
  nodes: readonly ApplicationNode[],
): readonly { readonly node: ApplicationNode; readonly path: string }[] =>
  nodes.flatMap((node) => {
    const path = javascriptModulePath(node);
    return path === null ? [] : [{ node, path }];
  });

const stripSourceText = (
  properties: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue> =>
  Object.fromEntries(
    Object.entries(properties).filter(([key]) => !SOURCE_TEXT_KEYS.has(key)),
  );

const exportNames = (node: ApplicationNode): readonly string[] => {
  const names = new Set<string>();
  for (const observation of node.observations) {
    const value = observation.properties.export_names;
    if (!Array.isArray(value)) continue;
    for (const entry of value) if (typeof entry === "string") names.add(entry);
  }
  return [...names];
};

const nodeHashes = (node: ApplicationNode): readonly string[] => {
  const hashes = new Set<string>();
  const { identity } = node;
  if (identity.strategy === "content-digest") hashes.add(identity.sha256);
  if (identity.strategy === "canonical-path")
    hashes.add(identity.artifact_sha256);
  if (identity.strategy === "source-map-original") {
    hashes.add(identity.source_map_sha256);
    if (identity.source_sha256 !== null) hashes.add(identity.source_sha256);
  }
  for (const observation of node.observations) {
    for (const key of ["sha256", "container_sha256", "entry_sha256"] as const) {
      const value = observation.properties[key];
      if (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value))
        hashes.add(value);
    }
  }
  return [...hashes];
};

const sourceRanges = (node: ApplicationNode): readonly JsonValue[] =>
  node.observations.flatMap((observation) => {
    const location = observation.evidence.location;
    return location.available && location.value.kind === "source-range"
      ? [location.value]
      : [];
  });

const moduleItem = (node: ApplicationNode): JsonValue => ({
  node_id: node.node_id,
  kind: node.kind,
  path: javascriptModulePath(node),
  identity: node.identity,
  hashes: [...nodeHashes(node)],
  exports: [...exportNames(node)],
  source_ranges: [...sourceRanges(node)],
  observations: node.observations.map((observation) => ({
    observation_id: observation.observation_id,
    label: observation.label,
    properties: stripSourceText(observation.properties),
    evidence: {
      ...observation.evidence,
      location: observation.evidence.location,
    },
  })),
});

const javascriptUnknowns = (
  analysis: JavaScriptApplicationAnalysisResult,
): readonly string[] => {
  const unknowns = [...analysis.limitations, ...analysis.graph.limitations];
  if (analysis.graph.coverage.status !== "complete")
    unknowns.push(
      `graph.coverage.status is ${analysis.graph.coverage.status}`,
    );
  return unknowns;
};

const parentFields = (
  parent: AnalysisViewParent,
  analysis: JavaScriptApplicationAnalysisResult,
) => ({
  parent_evidence_id: parent.evidenceId,
  parent_operation: "analyze_javascript_application" as const,
  parent_digest: parent.evidenceId.slice(3),
  artifact: {
    path: analysis.input_path,
    sha256: analysis.root_artifact_sha256,
  },
  limitations: uniqueSorted([
    ...parent.limitations,
    ...analysis.limitations,
    ...analysis.graph.limitations,
  ]),
  unknowns: uniqueSorted([...javascriptUnknowns(analysis)]),
});

const selectModule = (
  nodes: readonly ApplicationNode[],
  selector: Extract<
    AnalysisViewRequest,
    { readonly kind: "item" }
  >["selector"],
): Result<ApplicationNode, AnalysisError> => {
  if ("node_id" in selector) {
    const matches = nodes.filter((node) => node.node_id === selector.node_id);
    if (matches.length === 1) {
      const selected = matches[0];
      if (selected !== undefined) return ok(selected);
    }
    return err(
      inputError([
        {
          path: ["view", "selector", "node_id"],
          reason: "invalid_value",
          message: `No module has node_id ${JSON.stringify(selector.node_id)}.`,
          expected: nodes.map((node) => node.node_id).slice(0, 32),
        },
      ]),
    );
  }
  if ("path" in selector) {
    const matches = moduleEntries(nodes).filter(
      (entry) => entry.path === selector.path,
    );
    if (matches.length === 1) {
      const selected = matches[0];
      if (selected !== undefined) return ok(selected.node);
    }
    if (matches.length === 0)
      return err(
        inputError([
          {
            path: ["view", "selector", "path"],
            reason: "invalid_value",
            message: `No module has path ${JSON.stringify(selector.path)}.`,
            expected: [
              ...new Set(moduleEntries(nodes).map((entry) => entry.path)),
            ].slice(0, 32),
          },
        ]),
      );
    return err(
      inputError([
        {
          path: ["view", "selector", "path"],
          reason: "invalid_value",
          message: `Multiple modules have path ${JSON.stringify(selector.path)}; select one by node_id.`,
          expected: matches.map((entry) => ({ node_id: entry.node.node_id })),
        },
      ]),
    );
  }
  return err(
    jsIncompatible("Module items are selected by exact path or node_id."),
  );
};

/** Project one JavaScript application view without re-running reconstruction. */
export const projectJavaScriptApplicationView = (
  parent: AnalysisViewParent,
  analysis: JavaScriptApplicationAnalysisResult,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  const shared = parentFields(parent, analysis);
  const modules = moduleEntries(analysis.graph.nodes);
  if (view.kind === "summary")
    return ok({
      kind: "summary",
      view,
      summary: {
        input_path: analysis.input_path,
        format: analysis.format,
        root_artifact_sha256: analysis.root_artifact_sha256,
        statistics: jsonObjectSchema.parse(analysis.statistics),
        electron: jsonObjectSchema.parse(analysis.summary),
        limitation_count: analysis.limitations.length,
      },
      coverage: completeCoverage(
        modules.length,
        analysis.graph.nodes.length,
      ),
      ...shared,
    });
  if (view.kind === "facet")
    return err(
      jsIncompatible(
        "facet views apply to inspect_binary_layout Evidence (mitigations or linkage).",
      ),
    );
  if (view.kind === "item") {
    if (view.collection !== "modules")
      return err(
        jsIncompatible(
          "Section and symbol collections apply to inspect_binary_layout Evidence.",
        ),
      );
    const selected = selectModule(analysis.graph.nodes, view.selector);
    if (!selected.ok) return selected;
    return ok({
      kind: "item",
      view,
      item: moduleItem(selected.value),
      coverage: completeCoverage(1, modules.length),
      ...shared,
    });
  }
  if (view.collection !== "modules")
    return err(
      jsIncompatible(
        "Section and symbol collections apply to inspect_binary_layout Evidence.",
      ),
    );
  const items = modules
    .slice(view.offset, view.offset + view.limit)
    .map(({ node, path }) => ({
      node_id: node.node_id,
      kind: node.kind,
      path,
    }));
  return ok({
    kind: "page",
    view,
    items,
    coverage: pageCoverage(view.offset, items.length, modules.length),
    ...shared,
  });
};
