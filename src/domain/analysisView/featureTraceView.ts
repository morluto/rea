import { z } from "zod";
import { prefixedDigestSchema } from "../digests.js";
import { applicationCoverageSchema } from "../javascript/javascriptApplicationEvidenceSchemas.js";
import {
  applicationEdgeSchema,
  applicationNodeSchema,
  type ApplicationEdge,
  type ApplicationNode,
} from "../javascript/javascriptApplicationGraphSchemas.js";
import {
  applicationFeatureTraceResultSchema,
  type ApplicationFeatureTraceResult,
} from "../javascript/javascriptFeatureTraceSchemas.js";
import { err, ok } from "../result.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  ownedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import {
  javascriptFactBasis,
  javascriptFactBasisSchema,
} from "./javascriptModuleReferences.js";
import { selectViewRows } from "./selectViewRows.js";

const OPERATION = "trace_application_feature" as const;
const trace = applicationFeatureTraceResultSchema.shape;

const nodeIdsFilter = z
  .array(prefixedDigestSchema("jag_node"))
  .optional()
  .describe(
    "Exact trace node identities. Omitted selects all; [] selects none.",
  );
const page = {
  kind: z.literal("feature-trace"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
};

const pathsRequestSchema = z.strictObject({
  ...page,
  collection: z.literal("paths"),
  where: z
    .strictObject({
      node_ids: nodeIdsFilter.describe(
        "Select terminal paths that visit any of these exact node identities. Omitted selects all; [] selects none.",
      ),
      end_kinds: z.array(applicationNodeSchema.shape.kind).optional(),
    })
    .default({}),
});
const nodesRequestSchema = z.strictObject({
  ...page,
  collection: z.literal("nodes"),
  where: z
    .strictObject({
      node_ids: nodeIdsFilter,
      kinds: z.array(applicationNodeSchema.shape.kind).optional(),
    })
    .default({}),
  include_observations: z
    .boolean()
    .default(false)
    .describe(
      "Opt into each selected node's complete retained observations, including properties and provenance.",
    ),
});
const edgesRequestSchema = z.strictObject({
  ...page,
  collection: z.literal("edges"),
  where: z
    .strictObject({
      node_ids: nodeIdsFilter.describe(
        "Select edges whose source or target is one of these exact node identities. Omitted selects all; [] selects none.",
      ),
      relations: z.array(applicationEdgeSchema.shape.relation).optional(),
    })
    .default({}),
});
const seedMatchesRequestSchema = z.strictObject({
  ...page,
  collection: z.literal("seed_matches"),
});
const handoffsRequestSchema = z.strictObject({
  ...page,
  collection: z.literal("native_handoffs"),
});

/** Page one collection of a completed feature trace in its retained order. */
export const featureTraceViewRequestSchema = z.discriminatedUnion(
  "collection",
  [
    pathsRequestSchema,
    nodesRequestSchema,
    edgesRequestSchema,
    seedMatchesRequestSchema,
    handoffsRequestSchema,
  ],
);

type FeatureTraceViewRequest = z.output<typeof featureTraceViewRequestSchema>;

/** Compact node identity and support; full observations are opt-in. */
const featureTraceNodeRowSchema = applicationNodeSchema
  .pick({ node_id: true, kind: true, identity: true })
  .extend({
    seed: z
      .boolean()
      .describe("Whether this node matched the trace seed (a trace root)."),
    observation_count: z.int().positive(),
    basis: z.array(javascriptFactBasisSchema).min(1),
    observations: applicationNodeSchema.shape.observations.exactOptional(),
  });

/**
 * Each collection's request bound to its own rows, so a reply cannot pair one
 * collection with another's rows. Rows are the producer's exact records or the
 * compact node projection.
 */
export const featureTraceViewCollections = {
  paths: { request: pathsRequestSchema, rows: z.array(trace.paths.element) },
  nodes: {
    request: nodesRequestSchema,
    rows: z.array(featureTraceNodeRowSchema),
  },
  edges: { request: edgesRequestSchema, rows: z.array(applicationEdgeSchema) },
  seed_matches: {
    request: seedMatchesRequestSchema,
    rows: z.array(trace.seed_matches.element),
  },
  native_handoffs: {
    request: handoffsRequestSchema,
    rows: z.array(trace.native_handoffs.element),
  },
} as const;

/** Trace identity and coverage repeated with every view so selected rows stay traceable. */
export const featureTraceViewContextSchema = z.strictObject({
  trace_id: trace.trace_id,
  source_evidence_id: trace.source_evidence_id,
  source_graph_id: trace.source_graph_id,
  seed: trace.seed,
  direction: trace.direction,
  summary: trace.summary,
  trace_coverage: trace.coverage,
  graph_coverage: applicationCoverageSchema
    .nullable()
    .describe("The traced subgraph's coverage, or null when no seed matched."),
  evidence_links: trace.evidence_links,
});

/** Summary context adds the producer's already paged no-match discovery. */
export const featureTraceSummarySchema = featureTraceViewContextSchema.extend({
  semantic_discovery: trace.semantic_discovery,
  limitation_count: z.int().nonnegative(),
});

const checkedTrace = createAnalysisViewResultReader(
  applicationFeatureTraceResultSchema,
);

const selected = <Value>(values: readonly Value[] | undefined) =>
  values === undefined ? undefined : new Set(values);

const traceContext = (result: ApplicationFeatureTraceResult) => ({
  trace_id: result.trace_id,
  source_evidence_id: result.source_evidence_id,
  source_graph_id: result.source_graph_id,
  seed: result.seed,
  direction: result.direction,
  summary: result.summary,
  trace_coverage: result.coverage,
  graph_coverage: result.graph?.coverage ?? null,
  evidence_links: result.evidence_links,
});

const traceUnknowns = (result: ApplicationFeatureTraceResult): string[] => [
  ...(result.coverage.status === "partial"
    ? [
        `trace_coverage.status is partial because the source application graph is ${result.coverage.source_graph_status}; unmatched seeds and frontiers remain unknown.`,
      ]
    : []),
  "Trace connectivity does not prove runtime execution or reachability. Exhausting a page establishes nothing outside this trace.",
];

const nodeRow = (
  node: ApplicationNode,
  seeds: ReadonlySet<string>,
  includeObservations: boolean,
): z.output<typeof featureTraceNodeRowSchema> => ({
  node_id: node.node_id,
  kind: node.kind,
  identity: node.identity,
  seed: seeds.has(node.node_id),
  observation_count: node.observations.length,
  basis: javascriptFactBasis(node.observations.map(({ evidence }) => evidence)),
  ...(includeObservations ? { observations: node.observations } : {}),
});

/** One page per collection, built in its own branch so view and rows stay correlated. */
const tracePage = <Shared extends object>(
  result: ApplicationFeatureTraceResult,
  view: FeatureTraceViewRequest,
  shared: Shared,
) => {
  const pageOf = <View extends FeatureTraceViewRequest, Row>(
    selection: View,
    { rows, total }: { readonly rows: Row[]; readonly total: number },
  ) => ({
    kind: "feature-trace" as const,
    view: selection,
    ...shared,
    items: rows,
    coverage: pageViewCoverage(selection.offset, rows.length, total),
  });
  const all = () => true;
  if (view.collection === "seed_matches")
    return pageOf(
      view,
      selectViewRows(result.seed_matches, view, all, (row) => row),
    );
  if (view.collection === "native_handoffs")
    return pageOf(
      view,
      selectViewRows(result.native_handoffs, view, all, (row) => row),
    );
  if (view.collection === "paths") {
    const nodes = selected(view.where.node_ids);
    const ends = selected<string>(view.where.end_kinds);
    return pageOf(
      view,
      selectViewRows(
        result.paths,
        view,
        (path) =>
          (ends === undefined || ends.has(path.end_kind)) &&
          (nodes === undefined || path.node_ids.some((id) => nodes.has(id))),
        (path) => path,
      ),
    );
  }
  const graph = result.graph;
  if (view.collection === "edges") {
    const nodes = selected(view.where.node_ids);
    const relations = selected(view.where.relations);
    return pageOf(
      view,
      selectViewRows<ApplicationEdge, ApplicationEdge>(
        graph?.edges ?? [],
        view,
        (edge) =>
          (relations === undefined || relations.has(edge.relation)) &&
          (nodes === undefined ||
            nodes.has(edge.source_node_id) ||
            nodes.has(edge.target_node_id)),
        (edge) => edge,
      ),
    );
  }
  const ids = selected(view.where.node_ids);
  const kinds = selected(view.where.kinds);
  const seeds = new Set(result.seed_matches.map(({ node_id: id }) => id));
  return pageOf(
    view,
    selectViewRows(
      graph?.nodes ?? [],
      view,
      (node) =>
        (ids === undefined || ids.has(node.node_id)) &&
        (kinds === undefined || kinds.has(node.kind)),
      (node) => nodeRow(node, seeds, view.include_observations),
    ),
  );
};

/** Select retained trace facts without re-running traversal or changing its coverage. */
export const projectFeatureTraceView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const view = ownedView<SummaryAnalysisView | FeatureTraceViewRequest>(
    admitted,
    "summary",
    "feature-trace",
  );
  if (view === undefined)
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Application feature traces support summary and feature-trace pages of paths, nodes, edges, seed_matches or native_handoffs.",
        },
      ]),
    );
  const parsed = checkedTrace(parent);
  if (!parsed.ok) return parsed;
  const result = parsed.value;
  const limitations = [
    ...parent.limitations,
    ...result.limitations,
    ...(result.graph?.limitations ?? []),
  ];
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: OPERATION,
    parent_digest: parent.evidenceId.slice(3),
    artifact: null,
    limitations: boundedViewMessages(
      limitations,
      parent.evidenceId,
      "limitations",
    ),
    unknowns: boundedViewMessages(
      [],
      parent.evidenceId,
      "unknowns",
      traceUnknowns(result),
    ),
  };
  const context = traceContext(result);
  if (view.kind === "summary")
    return ok({
      kind: "summary" as const,
      view,
      ...shared,
      summary: {
        ...context,
        ...(result.semantic_discovery === undefined
          ? {}
          : { semantic_discovery: result.semantic_discovery }),
        limitation_count: new Set(limitations).size,
      },
      coverage: completeWithinViewCoverage(1, 1),
    });
  return ok(tracePage(result, view, { ...shared, ...context }));
};
