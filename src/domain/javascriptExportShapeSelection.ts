import type {
  ApplicationNode,
  JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import { compareCodePoints } from "./javascriptApplicationGraph.js";
import {
  projectedExportReturnShapesSchema,
  type JavaScriptExportShapeComparisonResult,
  type ProjectedExportReturnShapes,
} from "./javascriptExportShapeComparisonSchemas.js";

type Shape = ProjectedExportReturnShapes["static_return_shapes"][number];
type SelectorResult = JavaScriptExportShapeComparisonResult["left"];

/** One authenticated graph and exact export selector. */
export interface JavaScriptExportShapeSideInput {
  readonly evidenceId: string;
  readonly graph: JavaScriptApplicationGraph;
  readonly modulePath: string;
  readonly exportName: string;
}

interface ExportCandidate {
  readonly node: ApplicationNode;
  readonly modulePath: string;
  readonly exportName: string;
  readonly trusted: boolean;
}

/** Exact selector result plus any admitted static return-shape projection. */
export interface SelectedJavaScriptExport {
  readonly selection: SelectorResult;
  readonly projection: ProjectedExportReturnShapes | null;
  readonly observationComplete: boolean;
  readonly limitations: readonly string[];
}

/** Caller-retained return shapes and their exact caller-limit omission count. */
export interface RetainedJavaScriptExportShapes {
  readonly shapes: readonly Shape[];
  readonly omitted: number;
}

/** Select one exact trusted export and its exact static return-shape observation. */
export const selectJavaScriptExport = (
  side: JavaScriptExportShapeSideInput,
  maxCandidates: number,
): SelectedJavaScriptExport => {
  const candidates = exportCandidates(side.graph);
  const exact = candidates.filter(
    ({ modulePath, exportName }) =>
      modulePath === side.modulePath && exportName === side.exportName,
  );
  const matchingOneSelector = candidates.filter(
    ({ modulePath, exportName }) =>
      modulePath === side.modulePath || exportName === side.exportName,
  );
  const diagnosticPool =
    exact.length > 0
      ? exact
      : matchingOneSelector.length > 0
        ? matchingOneSelector
        : candidates;
  const retainedCandidates = diagnosticPool.slice(0, maxCandidates);
  const base = selectorBase(side, diagnosticPool, retainedCandidates);
  if (exact.length === 0)
    return unresolvedSelection(base, "missing", null, [
      `No exact export binding matched ${side.modulePath}:${side.exportName}.`,
    ]);
  if (exact.length > 1)
    return unresolvedSelection(base, "ambiguous", null, [
      `Multiple exact export bindings matched ${side.modulePath}:${side.exportName}; none was selected.`,
    ]);
  const selected = exact[0];
  if (selected === undefined || !selected.trusted)
    return unresolvedSelection(
      base,
      "unavailable",
      selected?.node.node_id ?? null,
      [
        "The exact export binding lacks the expected static-analysis authority.",
      ],
    );
  const returnShape = returnShapeFor(selected.node, side);
  if (returnShape.projection === null)
    return unresolvedSelection(base, "unavailable", selected.node.node_id, [
      returnShape.reason,
    ]);
  return {
    selection: {
      ...base,
      status: "selected",
      selected_node_id: selected.node.node_id,
    },
    projection: returnShape.projection,
    observationComplete: returnShape.observationComplete,
    limitations: [],
  };
};

/** Apply the caller's explicit return-variant limit. */
export const retainJavaScriptExportShapes = (
  selection: SelectedJavaScriptExport,
  maximum: number,
): RetainedJavaScriptExportShapes => {
  const shapes = selection.projection?.static_return_shapes ?? [];
  const retained = shapes.slice(0, maximum);
  return { shapes: retained, omitted: shapes.length - retained.length };
};

const selectorBase = (
  side: JavaScriptExportShapeSideInput,
  candidates: readonly ExportCandidate[],
  retained: readonly ExportCandidate[],
): Omit<SelectorResult, "status" | "selected_node_id"> => ({
  evidence_id: side.evidenceId,
  graph_id: side.graph.graph_id,
  requested_module_path: side.modulePath,
  requested_export_name: side.exportName,
  candidates: retained.map((candidate) => ({
    node_id: candidate.node.node_id,
    module_path: candidate.modulePath,
    export_name: candidate.exportName,
    matches_requested_module: candidate.modulePath === side.modulePath,
    matches_requested_export: candidate.exportName === side.exportName,
  })),
  omitted_candidates: candidates.length - retained.length,
});

const unresolvedSelection = (
  base: Omit<SelectorResult, "status" | "selected_node_id">,
  status: "missing" | "ambiguous" | "unavailable",
  nodeId: string | null,
  limitations: readonly string[],
): SelectedJavaScriptExport => ({
  selection: { ...base, status, selected_node_id: nodeId },
  projection: null,
  observationComplete: false,
  limitations,
});

const exportCandidates = (
  graph: JavaScriptApplicationGraph,
): ExportCandidate[] => {
  const candidates = new Map<string, ExportCandidate>();
  for (const node of graph.nodes) {
    for (const observation of node.observations) {
      const properties = observation.properties;
      if (properties.semantic_role !== "export-binding") continue;
      const modulePath = properties.module_path;
      const exportName = properties.exported_name;
      if (typeof modulePath !== "string" || typeof exportName !== "string")
        continue;
      const key = `${node.node_id}\0${modulePath}\0${exportName}`;
      const trusted =
        observation.evidence.authority === "ast-static-analysis" &&
        observation.evidence.state === "observed" &&
        observation.evidence.extractor.operation === "recover-module-export";
      const existing = candidates.get(key);
      candidates.set(key, {
        node,
        modulePath,
        exportName,
        trusted: trusted || existing?.trusted === true,
      });
    }
  }
  return [...candidates.values()].sort((left, right) =>
    compareCodePoints(candidateKey(left), candidateKey(right)),
  );
};

const candidateKey = (candidate: ExportCandidate): string =>
  `${candidate.modulePath}\0${candidate.exportName}\0${candidate.node.node_id}`;

const returnShapeFor = (
  node: ApplicationNode,
  side: JavaScriptExportShapeSideInput,
): {
  readonly projection: ProjectedExportReturnShapes | null;
  readonly observationComplete: boolean;
  readonly reason: string;
} => {
  const roleObservations = node.observations.filter(
    ({ properties }) => properties.semantic_role === "export-return-shapes",
  );
  const parsed = roleObservations.map((observation) => ({
    observation,
    result: projectedExportReturnShapesSchema.safeParse(observation.properties),
  }));
  if (parsed.some(({ result }) => !result.success))
    return unavailableReturnShape(
      "The export return-shape observation is malformed.",
    );
  const matching = parsed.filter(
    ({ result }) =>
      result.success &&
      result.data.module_path === side.modulePath &&
      result.data.exported_name === side.exportName,
  );
  if (matching.length !== 1)
    return unavailableReturnShape(
      matching.length === 0
        ? "No exact static return-shape observation is available for the selected export."
        : "Multiple static return-shape observations matched the selected export.",
    );
  const selected = matching[0];
  if (selected === undefined || !selected.result.success)
    return unavailableReturnShape(
      "The selected return-shape observation could not be parsed.",
    );
  const { observation } = selected;
  const trusted =
    observation.evidence.authority === "static-relationship-inference" &&
    observation.evidence.state === "inferred" &&
    observation.evidence.extractor.operation === "recover-export-return-shapes";
  if (!trusted)
    return unavailableReturnShape(
      "The return-shape observation lacks the expected static-inference authority.",
    );
  return {
    projection: selected.result.data,
    observationComplete:
      observation.evidence.coverage.status === "complete" &&
      !observation.evidence.coverage.truncated,
    reason: "",
  };
};

const unavailableReturnShape = (reason: string) => ({
  projection: null,
  observationComplete: false,
  reason,
});
