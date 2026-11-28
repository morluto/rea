import { appendToMapList } from "../appendToMapList.js";
import { isImmutableJsonSnapshot } from "../immutableJson.js";
import { isJavaScriptModuleUnit } from "../javascript/javascriptModuleUnits.js";
import {
  analysisViewInputError,
  invalidAnalysisView,
} from "./analysisViewErrors.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { uniqueSorted } from "../canonicalOrdering.js";
import { jsonObjectSchema, type JsonValue } from "../jsonValue.js";
import type { JavaScriptApplicationAnalysisResult } from "../javascript/javascriptApplicationAnalysis.js";
import type { ApplicationNode } from "../javascript/javascriptApplicationGraphSchemas.js";
import { err, ok, type Result } from "../result.js";
import { z } from "zod";
import type { JavaScriptModuleReference } from "./javascriptModuleReferences.js";
import {
  javascriptFactBasis,
  javascriptModuleReferencesRequestSchema,
} from "./javascriptModuleReferences.js";
import {
  javascriptApplicationSourceCoverage,
  javascriptStaticSourceCoverageSummary,
  type JavaScriptApplicationSourceCoverage,
} from "./javascriptApplicationCoverage.js";
import {
  projectJavaScriptFactGroups,
  projectJavaScriptFacts,
  javascriptFactGroupsViewRequestSchema,
  javascriptFactsViewRequestSchema,
} from "./javascriptFactsView.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage as completeCoverage,
  pageViewCoverage as pageCoverage,
} from "./analysisViewCoverage.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  assertOwnedView,
  type AdmittedView,
  type ItemAnalysisView,
  type PageAnalysisView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";

/** Every exact module path or original source-map reference retained by a node. */
const javascriptModulePaths = (node: ApplicationNode): readonly string[] => {
  if (node.identity.strategy === "canonical-path") return [node.identity.path];
  if (node.identity.strategy === "source-map-original")
    return [node.identity.original_source];
  const paths = new Set<string>();
  for (const observation of node.observations) {
    const path = observation.properties.path;
    if (typeof path === "string") {
      paths.add(path);
      continue;
    }
    const location = observation.evidence.location;
    if (location.available && location.value.kind === "artifact-path")
      paths.add(location.value.path);
    if (location.available && location.value.kind === "source-range")
      paths.add(location.value.source);
  }
  return [...paths];
};

interface ModuleEntry {
  readonly node: ApplicationNode & {
    readonly kind: JavaScriptModuleReference["kind"];
  };
  readonly path: string | null;
  readonly paths: readonly string[];
}

/** One owner for the module kinds and path semantics of every module view. */
function* moduleEntries(
  nodes: readonly ApplicationNode[],
): Generator<ModuleEntry> {
  for (const node of nodes) {
    if (isJavaScriptModuleUnit(node)) {
      const paths = javascriptModulePaths(node);
      yield { node, path: paths[0] ?? null, paths };
    }
  }
}

interface ModuleIndex {
  readonly moduleEntries: readonly ModuleEntry[];
  readonly byNodeId: ReadonlyMap<string, ModuleEntry | null>;
  readonly nodesByPath: ReadonlyMap<string | null, readonly ModuleEntry[]>;
  readonly nodesByKind: ReadonlyMap<
    JavaScriptModuleReference["kind"],
    readonly ModuleEntry[]
  >;
}

const moduleIndexes = new WeakMap<
  JavaScriptApplicationAnalysisResult,
  ModuleIndex
>();

const buildModuleIndex = (nodes: readonly ApplicationNode[]): ModuleIndex => {
  const entries: ModuleEntry[] = [];
  const byNodeId = new Map<string, ModuleEntry | null>();
  const nodesByPath = new Map<string | null, ModuleEntry[]>();
  const nodesByKind = new Map<
    JavaScriptModuleReference["kind"],
    ModuleEntry[]
  >();
  for (const entry of moduleEntries(nodes)) {
    entries.push(entry);
    byNodeId.set(
      entry.node.node_id,
      byNodeId.has(entry.node.node_id) ? null : entry,
    );
    if (entry.paths.length === 0) {
      appendToMapList(nodesByPath, null, entry);
    } else {
      for (const path of entry.paths) {
        appendToMapList(nodesByPath, path, entry);
      }
    }
    appendToMapList(nodesByKind, entry.node.kind, entry);
  }
  return { moduleEntries: entries, byNodeId, nodesByPath, nodesByKind };
};

const getModuleIndex = (
  analysis: JavaScriptApplicationAnalysisResult,
): ModuleIndex | undefined => {
  if (!isImmutableJsonSnapshot(analysis)) return undefined;
  let index = moduleIndexes.get(analysis);
  if (index === undefined) {
    index = buildModuleIndex(analysis.graph.nodes);
    moduleIndexes.set(analysis, index);
  }
  return index;
};

type ModulePageRequest = {
  readonly offset: number;
  readonly limit: number;
  readonly where?: z.output<
    typeof javascriptModuleReferencesRequestSchema
  >["where"];
};

const paginateModuleEntries = (
  iterable: Iterable<ModuleEntry>,
  view: ModulePageRequest,
): { entries: readonly ModuleEntry[]; total: number } => {
  const entries: ModuleEntry[] = [];
  let total = 0;
  for (const entry of iterable) {
    if (view.where?.kind !== undefined && entry.node.kind !== view.where.kind)
      continue;
    const selectedPath = view.where?.path;
    if (
      selectedPath !== undefined &&
      (selectedPath === null
        ? entry.path !== null
        : !entry.paths.includes(selectedPath))
    )
      continue;
    if (total >= view.offset && entries.length < view.limit)
      entries.push(
        selectedPath !== undefined && selectedPath !== null
          ? { ...entry, path: selectedPath }
          : entry,
      );
    total += 1;
  }
  return { entries, total };
};

/** Scan retained order once (or slice pre-built immutable index in O(page)). */
const modulePage = (
  analysis: JavaScriptApplicationAnalysisResult,
  view: ModulePageRequest,
): { entries: readonly ModuleEntry[]; total: number } => {
  const index = getModuleIndex(analysis);
  if (index === undefined)
    return paginateModuleEntries(moduleEntries(analysis.graph.nodes), view);
  const selectedKind = view.where?.kind;
  const selectedPath = view.where?.path;
  if (selectedPath !== undefined && selectedKind === undefined) {
    const candidates = index.nodesByPath.get(selectedPath) ?? [];
    const slice = candidates.slice(view.offset, view.offset + view.limit);
    return {
      entries:
        selectedPath === null
          ? slice
          : slice.map((entry) => ({ ...entry, path: selectedPath })),
      total: candidates.length,
    };
  }
  if (selectedPath === undefined && selectedKind !== undefined) {
    const candidates = index.nodesByKind.get(selectedKind) ?? [];
    return {
      entries: candidates.slice(view.offset, view.offset + view.limit),
      total: candidates.length,
    };
  }
  if (selectedPath === undefined && selectedKind === undefined)
    return {
      entries: index.moduleEntries.slice(view.offset, view.offset + view.limit),
      total: index.moduleEntries.length,
    };
  return paginateModuleEntries(
    index.nodesByPath.get(selectedPath!) ?? [],
    view,
  );
};

const exportNames = (node: ApplicationNode): readonly string[] => {
  const names = new Set<string>();
  for (const observation of node.observations) {
    const value =
      observation.properties.export_names ?? observation.properties.exports;
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
    for (const key of [
      "sha256",
      "container_sha256",
      "entry_sha256",
      "source_sha256",
    ] as const) {
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

const moduleItem = (node: ApplicationNode, path: string | null): JsonValue => ({
  node_id: node.node_id,
  kind: node.kind,
  path,
  identity: node.identity,
  hashes: [...nodeHashes(node)],
  exports: [...exportNames(node)],
  source_ranges: [...sourceRanges(node)],
  observations: node.observations,
});

const moduleReference = ({
  node,
  path,
}: ModuleEntry): JavaScriptModuleReference => {
  let ranges = 0;
  for (const { evidence } of node.observations)
    if (
      evidence.location.available &&
      evidence.location.value.kind === "source-range"
    )
      ranges += 1;
  return {
    node_id: node.node_id,
    kind: node.kind,
    path,
    identity: node.identity,
    retained_source_range_count: ranges,
    basis: javascriptFactBasis(
      node.observations.map(({ evidence }) => evidence),
    ),
  };
};

const javascriptCoverageUnknowns = (
  coverage: JavaScriptApplicationSourceCoverage,
): readonly string[] => {
  const unknowns: string[] = [];
  if (coverage.application.status !== "complete")
    unknowns.push(`graph.coverage.status is ${coverage.application.status}`);
  if (coverage.semantic.status !== "complete")
    unknowns.push(
      `semantic_graph.coverage.status is ${coverage.semantic.status}`,
    );
  const applicationUnknowns = coverage.application_unknown_count;
  if (applicationUnknowns > 0)
    unknowns.push(
      `${String(applicationUnknowns)} application graph unknowns remain in the parent Evidence.`,
    );
  if (coverage.semantic_unknown_count > 0)
    unknowns.push(
      `${String(coverage.semantic_unknown_count)} semantic graph unknowns remain in the parent Evidence.`,
    );
  return unknowns;
};

const parentFields = (
  parent: AnalysisViewParent,
  analysis: JavaScriptApplicationAnalysisResult,
  sourceCoverage: JavaScriptApplicationSourceCoverage,
) => {
  const limitations = [
    ...analysis.limitations,
    ...analysis.graph.limitations,
    ...analysis.semantic_graph.limitations,
  ];
  const mergedLimitations = uniqueSorted([
    ...parent.limitations,
    ...limitations,
  ]);
  return {
    limitationCount: mergedLimitations.length,
    fields: {
      parent_evidence_id: parent.evidenceId,
      parent_operation: "analyze_javascript_application" as const,
      parent_digest: parent.evidenceId.slice(3),
      artifact: {
        path: analysis.input_path,
        sha256: analysis.root_artifact_sha256,
      },
      limitations: boundedViewMessages(
        mergedLimitations,
        parent.evidenceId,
        "limitations",
      ),
      unknowns: boundedViewMessages(
        limitations,
        parent.evidenceId,
        "unknowns",
        javascriptCoverageUnknowns(sourceCoverage),
      ),
    },
  };
};

const findSingleNodeById = (
  nodes: readonly ApplicationNode[],
  nodeId: string,
): ModuleEntry | undefined => {
  let matched:
    | (ApplicationNode & { readonly kind: JavaScriptModuleReference["kind"] })
    | undefined;
  for (const node of nodes) {
    if (!isJavaScriptModuleUnit(node) || node.node_id !== nodeId) continue;
    if (matched !== undefined) return undefined;
    matched = node;
  }
  if (matched === undefined) return undefined;
  const paths = javascriptModulePaths(matched);
  return { node: matched, path: paths[0] ?? null, paths };
};

const selectModule = (
  analysis: JavaScriptApplicationAnalysisResult,
  selector: ItemAnalysisView["selector"],
): Result<ModuleEntry, AnalysisError> => {
  const index = getModuleIndex(analysis);
  if ("node_id" in selector) {
    const selected =
      index !== undefined
        ? index.byNodeId.get(selector.node_id)
        : findSingleNodeById(analysis.graph.nodes, selector.node_id);
    if (selected !== undefined && selected !== null) return ok(selected);
    return invalidAnalysisView(
      `No module has node_id ${JSON.stringify(selector.node_id)}. Page the modules collection to inspect available identities.`,
      "selector",
      "node_id",
    );
  }
  if ("path" in selector) {
    const matches =
      index !== undefined
        ? (index.nodesByPath.get(selector.path) ?? [])
        : [...moduleEntries(analysis.graph.nodes)].filter((entry) =>
            selector.path === null
              ? entry.path === null
              : entry.paths.includes(selector.path),
          );
    if (matches.length === 1) {
      const selected = matches[0];
      if (selected !== undefined)
        return ok({ ...selected, path: selector.path });
    }
    if (matches.length === 0)
      return invalidAnalysisView(
        `No module has path ${JSON.stringify(selector.path)}. Page the modules collection to inspect exact paths and node_id values.`,
        "selector",
        "path",
      );
    return err(
      analysisViewInputError([
        {
          path: ["view", "selector", "path"],
          reason: "invalid_value",
          message: `Multiple modules have path ${JSON.stringify(selector.path)}; select one by node_id.`,
          expected: matches.map((entry) => ({ node_id: entry.node.node_id })),
        },
      ]),
    );
  }
  return invalidAnalysisView(
    "Module items are selected by exact path or node_id.",
  );
};

/** Project one JavaScript application view without re-running reconstruction. */
export const projectJavaScriptApplicationView = (
  parent: AnalysisViewParent,
  analysis: JavaScriptApplicationAnalysisResult,
  view: AdmittedView,
) => {
  if (
    view.kind !== "summary" &&
    view.kind !== "item" &&
    view.kind !== "page" &&
    view.kind !== "javascript" &&
    view.kind !== "javascript-facts" &&
    view.kind !== "javascript-fact-groups"
  )
    return invalidAnalysisView(
      "JavaScript application Evidence supports summary, module item/page, typed module references, selected JavaScript facts or JavaScript fact groups.",
    );
  assertOwnedView<
    | SummaryAnalysisView
    | ItemAnalysisView
    | PageAnalysisView
    | z.output<typeof javascriptModuleReferencesRequestSchema>
    | z.output<typeof javascriptFactsViewRequestSchema>
    | z.output<typeof javascriptFactGroupsViewRequestSchema>
  >(
    view,
    "summary",
    "item",
    "page",
    "javascript",
    "javascript-facts",
    "javascript-fact-groups",
  );
  const sourceCoverage = javascriptApplicationSourceCoverage(analysis);
  const { fields: shared, limitationCount } = parentFields(
    parent,
    analysis,
    sourceCoverage,
  );
  if (view.kind === "javascript-fact-groups") {
    const { rows, total } = projectJavaScriptFactGroups(
      analysis.graph.nodes,
      view,
      isImmutableJsonSnapshot(analysis) ? analysis : undefined,
    );
    return ok({
      ...shared,
      kind: "javascript-fact-groups" as const,
      view,
      rows,
      source_coverage: sourceCoverage,
      coverage: pageCoverage(view.offset, rows.length, total),
    });
  }
  if (view.kind === "javascript-facts") {
    const { rows, total } = projectJavaScriptFacts(
      analysis.graph.nodes,
      view,
      isImmutableJsonSnapshot(analysis) ? analysis : undefined,
    );
    return ok({
      ...shared,
      kind: "javascript-facts" as const,
      view,
      rows,
      source_coverage: sourceCoverage,
      coverage: pageCoverage(view.offset, rows.length, total),
    });
  }
  if (view.kind === "javascript") {
    const { entries, total } = modulePage(analysis, view);
    const rows = entries.map(moduleReference);
    return ok({
      ...shared,
      kind: "javascript" as const,
      view,
      rows,
      source_coverage: sourceCoverage,
      coverage: pageCoverage(view.offset, rows.length, total),
    });
  }
  if (view.kind === "summary") {
    // Summary coverage counts modules. Graph nodes that are not modules stay
    // in summary.coverage.application rather than inflating this total.
    const cachedIndex = isImmutableJsonSnapshot(analysis)
      ? moduleIndexes.get(analysis)
      : undefined;
    const moduleCount =
      cachedIndex !== undefined
        ? cachedIndex.moduleEntries.length
        : analysis.graph.nodes.reduce(
            (count, node) => count + Number(isJavaScriptModuleUnit(node)),
            0,
          );
    return ok({
      kind: "summary" as const,
      view,
      summary: {
        input_path: analysis.input_path,
        format: analysis.format,
        root_artifact_sha256: analysis.root_artifact_sha256,
        ...(analysis.source_selection === undefined
          ? {}
          : {
              source_selection: analysis.source_selection,
            }),
        statistics: jsonObjectSchema.parse(analysis.statistics),
        electron: jsonObjectSchema.parse(analysis.summary),
        coverage: jsonObjectSchema.parse({
          static_sources: javascriptStaticSourceCoverageSummary(analysis),
          application: analysis.graph.coverage,
          semantic: {
            ...analysis.semantic_graph.coverage,
            families: analysis.semantic_graph.coverage.families.map(
              ({ unknown_ids, ...family }) => ({
                ...family,
                unknown_count: unknown_ids.length,
              }),
            ),
          },
          application_unknowns: sourceCoverage.application_unknown_count,
          semantic_unknowns: sourceCoverage.semantic_unknown_count,
        }),
        limitation_count: limitationCount,
      },
      coverage: completeCoverage(moduleCount),
      ...shared,
    });
  }
  if (view.kind === "item") {
    if (view.collection !== "modules")
      return invalidAnalysisView(
        "Section and symbol collections apply to inspect_binary_layout Evidence.",
      );
    const selected = selectModule(analysis, view.selector);
    if (!selected.ok) return selected;
    return ok({
      kind: "item" as const,
      view,
      item: moduleItem(selected.value.node, selected.value.path),
      coverage: completeCoverage(1),
      ...shared,
    });
  }
  if (view.kind !== "page" || view.collection !== "modules")
    return invalidAnalysisView(
      "Section and symbol collections apply to inspect_binary_layout Evidence.",
    );
  const { entries, total } = modulePage(analysis, view);
  const items = entries.map(({ node, path }) => ({
    node_id: node.node_id,
    kind: node.kind,
    path,
  }));
  return ok({
    kind: "page" as const,
    view,
    items,
    coverage: pageCoverage(view.offset, items.length, total),
    ...shared,
  });
};
