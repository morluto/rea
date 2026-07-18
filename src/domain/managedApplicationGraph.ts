import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { evidenceSchema, parseEvidence, type Evidence } from "./evidence.js";
import {
  createJavaScriptApplicationGraph,
  javascriptApplicationGraphSchema,
  type ApplicationEdge,
  type ApplicationNode,
} from "./javascriptApplicationGraph.js";
import {
  managedArtifactInspectionSchema,
  managedMemberInspectionSchema,
  managedNativeBoundaryInspectionSchema,
  type ManagedArtifactInspection,
  type ManagedMemberInspection,
  type ManagedNativeBoundaryInspection,
} from "./managedArtifact.js";
import type { JsonValue } from "./jsonValue.js";
import {
  assessManagedGraphOmissions,
  managedGraphEvidenceCoverage,
  managedGraphResultCoverage,
  totalManagedGraphOmitted,
} from "./managedApplicationGraphCoverage.js";
import {
  addArtifactNode,
  addArtifactIdentityNodes,
  addBoundaryNodes,
  addMemberNodes,
} from "./managedApplicationGraphNodes.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const boundedTextSchema = z.string().min(1).max(4_096);

const managedApplicationGraphLimitsSchema = z.strictObject({
  max_types: z.number().int().min(0).max(100_000).default(5_000),
  max_methods: z.number().int().min(0).max(100_000).default(10_000),
  max_fields: z.number().int().min(0).max(100_000).default(5_000),
  max_pinvoke_imports: z.number().int().min(0).max(100_000).default(5_000),
  max_native_implementations: z
    .number()
    .int()
    .min(0)
    .max(100_000)
    .default(5_000),
});

/** Authenticated managed Evidence records projected into the application graph. */
export const projectManagedApplicationGraphInputSchema = z
  .strictObject({
    managed_artifact: evidenceSchema.optional(),
    managed_members: evidenceSchema.optional(),
    managed_native_boundaries: evidenceSchema.optional(),
    limits: managedApplicationGraphLimitsSchema.default({
      max_types: 5_000,
      max_methods: 10_000,
      max_fields: 5_000,
      max_pinvoke_imports: 5_000,
      max_native_implementations: 5_000,
    }),
  })
  .superRefine((input, context) => {
    if (
      input.managed_artifact === undefined &&
      input.managed_members === undefined &&
      input.managed_native_boundaries === undefined
    )
      context.addIssue({
        code: "custom",
        message:
          "At least one managed artifact, member, or native-boundary Evidence record is required",
      });
  });

/** Managed-code projection result containing a validated application graph. */
export const managedApplicationGraphResultSchema = z.strictObject({
  schema_version: z.literal(1),
  projection_id: z.string().regex(/^magp_[a-f0-9]{64}$/u),
  root_artifact_sha256: digestSchema,
  source_evidence: z.strictObject({
    managed_artifact_evidence_id: evidenceIdSchema.nullable(),
    managed_members_evidence_id: evidenceIdSchema.nullable(),
    managed_native_boundaries_evidence_id: evidenceIdSchema.nullable(),
  }),
  summary: z.strictObject({
    graph_nodes: z.number().int().min(0),
    graph_edges: z.number().int().min(0),
    assemblies: z.number().int().min(0),
    modules: z.number().int().min(0),
    types: z.number().int().min(0),
    methods: z.number().int().min(0),
    fields: z.number().int().min(0),
    pinvoke_imports: z.number().int().min(0),
    native_implementations: z.number().int().min(0),
  }),
  graph: javascriptApplicationGraphSchema,
  coverage: z.strictObject({
    status: z.enum(["complete-within-inputs", "partial", "truncated"]),
    omitted_types: z.number().int().min(0),
    omitted_methods: z.number().int().min(0),
    omitted_fields: z.number().int().min(0),
    omitted_pinvoke_imports: z.number().int().min(0),
    omitted_native_implementations: z.number().int().min(0),
  }),
  evidence_links: z.array(evidenceIdSchema).min(1).max(3),
  limitations: z.array(boundedTextSchema).max(1_000),
});

export type ProjectManagedApplicationGraphInput = z.infer<
  typeof projectManagedApplicationGraphInputSchema
>;
export type ManagedApplicationGraphResult = z.infer<
  typeof managedApplicationGraphResultSchema
>;

export interface ParsedManagedGraphInput {
  readonly artifact: {
    readonly evidence: Evidence;
    readonly result: ManagedArtifactInspection;
  } | null;
  readonly members: {
    readonly evidence: Evidence;
    readonly result: ManagedMemberInspection;
  } | null;
  readonly boundaries: {
    readonly evidence: Evidence;
    readonly result: ManagedNativeBoundaryInspection;
  } | null;
}

export interface GraphBuildState {
  readonly nodes: ApplicationNode[];
  readonly edges: ApplicationEdge[];
  readonly artifactSha256: string;
  readonly artifactPath: string;
  readonly evidenceLinks: string[];
  readonly typeNodes: Map<string, ApplicationNode>;
  readonly methodNodes: Map<string, ApplicationNode>;
  readonly fieldNodes: Map<string, ApplicationNode>;
}

const sha256 = (value: JsonValue): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError("Managed application graph canonicalization failed");
  return createHash("sha256").update(serialized).digest("hex");
};

/** Project authenticated managed Evidence records into the application graph. */
export const projectManagedApplicationGraph = (
  input: ProjectManagedApplicationGraphInput,
): ManagedApplicationGraphResult => {
  const parsed = parseManagedInputs(input);
  const artifactIdentity = chooseArtifact(parsed);
  assertSameArtifact(parsed, artifactIdentity.sha256);
  const evidenceLinks = [
    parsed.artifact?.evidence.evidence_id,
    parsed.members?.evidence.evidence_id,
    parsed.boundaries?.evidence.evidence_id,
  ].filter((id): id is string => id !== undefined);
  const state: GraphBuildState = {
    nodes: [],
    edges: [],
    artifactSha256: artifactIdentity.sha256,
    artifactPath: artifactIdentity.path,
    evidenceLinks,
    typeNodes: new Map(),
    methodNodes: new Map(),
    fieldNodes: new Map(),
  };
  const artifactNode = addArtifactNode(state);
  addArtifactIdentityNodes(state, artifactNode, parsed);
  const memberCounts = addMemberNodes(
    state,
    artifactNode,
    parsed,
    input.limits,
  );
  const boundaryCounts = addBoundaryNodes(
    state,
    artifactNode,
    parsed,
    input.limits,
  );
  const omissions = omittedCounts(parsed, input.limits);
  const limitations = projectionLimitations(parsed, omissions);
  const graph = createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    schema_version: 1,
    root_node_ids: [artifactNode.node_id],
    nodes: state.nodes,
    edges: state.edges,
    coverage: managedGraphEvidenceCoverage(omissions),
    limitations,
  });
  const withoutId = {
    schema_version: 1 as const,
    root_artifact_sha256: state.artifactSha256,
    source_evidence: {
      managed_artifact_evidence_id:
        parsed.artifact?.evidence.evidence_id ?? null,
      managed_members_evidence_id: parsed.members?.evidence.evidence_id ?? null,
      managed_native_boundaries_evidence_id:
        parsed.boundaries?.evidence.evidence_id ?? null,
    },
    summary: {
      graph_nodes: graph.nodes.length,
      graph_edges: graph.edges.length,
      assemblies: parsed.artifact?.result.assembly === null ? 0 : 1,
      modules: parsed.artifact?.result.module === null ? 0 : 1,
      ...memberCounts,
      ...boundaryCounts,
    },
    graph,
    coverage: managedGraphResultCoverage(omissions),
    evidence_links: evidenceLinks,
    limitations,
  };
  return managedApplicationGraphResultSchema.parse({
    ...withoutId,
    projection_id: `magp_${sha256(withoutId)}`,
  });
};

const parseManagedInputs = (
  input: ProjectManagedApplicationGraphInput,
): ParsedManagedGraphInput => ({
  artifact:
    input.managed_artifact === undefined
      ? null
      : parseManagedEvidence(
          input.managed_artifact,
          "inspect_managed_artifact",
          managedArtifactInspectionSchema,
        ),
  members:
    input.managed_members === undefined
      ? null
      : parseManagedEvidence(
          input.managed_members,
          "inspect_managed_members",
          managedMemberInspectionSchema,
        ),
  boundaries:
    input.managed_native_boundaries === undefined
      ? null
      : parseManagedEvidence(
          input.managed_native_boundaries,
          "inspect_managed_native_boundaries",
          managedNativeBoundaryInspectionSchema,
        ),
});

const parseManagedEvidence = <Result>(
  rawEvidence: unknown,
  operation: string,
  schema: z.ZodType<Result>,
): { readonly evidence: Evidence; readonly result: Result } => {
  const evidence = parseEvidence(rawEvidence);
  if (evidence.operation !== operation)
    throw new TypeError(`Evidence operation is not ${operation}`);
  return { evidence, result: schema.parse(evidence.normalized_result) };
};

const chooseArtifact = (
  parsed: ParsedManagedGraphInput,
): { readonly sha256: string; readonly path: string } => {
  const result =
    parsed.artifact?.result ??
    parsed.members?.result ??
    parsed.boundaries?.result;
  if (result === undefined)
    throw new TypeError("Managed graph projection requires managed Evidence");
  return { sha256: result.artifact.sha256, path: result.artifact.path };
};

const assertSameArtifact = (
  parsed: ParsedManagedGraphInput,
  sha256Value: string,
): void => {
  for (const result of [
    parsed.artifact?.result,
    parsed.members?.result,
    parsed.boundaries?.result,
  ])
    if (result !== undefined && result.artifact.sha256 !== sha256Value)
      throw new TypeError(
        "Managed graph projection inputs must describe the same artifact SHA-256",
      );
};

const omittedCounts = (
  parsed: ParsedManagedGraphInput,
  limits: ProjectManagedApplicationGraphInput["limits"],
) =>
  assessManagedGraphOmissions(
    {
      artifact: parsed.artifact?.result ?? null,
      members: parsed.members?.result ?? null,
      boundaries: parsed.boundaries?.result ?? null,
    },
    limits,
  );

const projectionLimitations = (
  parsed: ParsedManagedGraphInput,
  omissions: ReturnType<typeof omittedCounts>,
): string[] => [
  "Managed graph projection preserves static metadata observations only; it does not execute managed code, load assemblies, or map managed tokens to native addresses.",
  ...(parsed.members === null
    ? [
        "Managed member Evidence was not supplied; type, method, and field nodes are absent.",
      ]
    : []),
  ...(parsed.boundaries === null
    ? [
        "Managed native-boundary Evidence was not supplied; P/Invoke and native-implementation nodes are absent.",
      ]
    : []),
  ...(omissions.partialInput
    ? ["At least one supplied managed Evidence record has partial coverage."]
    : []),
  ...(totalManagedGraphOmitted(omissions) > 0
    ? [
        "Projection output omits managed entities because of source pagination or managed application graph limits.",
      ]
    : []),
];
