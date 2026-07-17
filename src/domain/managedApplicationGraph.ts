import { createHash } from "node:crypto";
import { basename } from "node:path";

import canonicalize from "canonicalize";
import { z } from "zod";

import { evidenceSchema, parseEvidence, type Evidence } from "./evidence.js";
import {
  createJavaScriptApplicationEdge,
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
  javascriptApplicationGraphSchema,
  type ApplicationGraphEvidence,
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
  completeManagedGraphCoverage,
  managedGraphEvidenceCoverage,
  managedGraphResultCoverage,
  managedSourceCoverage,
  managedSourcePageCoverage,
  totalManagedGraphOmitted,
} from "./managedApplicationGraphCoverage.js";

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

type ManagedMethod = ManagedMemberInspection["methods"]["items"][number];
type ManagedField = ManagedMemberInspection["fields"]["items"][number];
type ManagedType = ManagedMemberInspection["types"]["items"][number];
type PinvokeImport =
  ManagedNativeBoundaryInspection["pinvoke_imports"]["items"][number];
type NativeImplementation =
  ManagedNativeBoundaryInspection["native_implementations"]["items"][number];

interface ParsedManagedGraphInput {
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

interface GraphBuildState {
  readonly nodes: ApplicationNode[];
  readonly edges: ReturnType<typeof createJavaScriptApplicationEdge>[];
  readonly artifactSha256: string;
  readonly artifactPath: string;
  readonly evidenceLinks: string[];
  readonly typeNodes: Map<string, ApplicationNode>;
  readonly methodNodes: Map<string, ApplicationNode>;
  readonly fieldNodes: Map<string, ApplicationNode>;
}

interface ContainsEdgeOptions {
  readonly kind: string;
  readonly coverage: ApplicationGraphEvidence["coverage"];
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

const addArtifactNode = (state: GraphBuildState): ApplicationNode => {
  const node = createJavaScriptApplicationNode({
    kind: "artifact",
    identity: {
      strategy: "content-digest",
      stability: "global-exact",
      sha256: state.artifactSha256,
    },
    observations: [
      {
        label: basename(state.artifactPath),
        properties: {
          format: "pe",
          source: "managed-application-graph",
        },
        evidence: managedEvidence(state, "project-managed-artifact"),
      },
    ],
  });
  state.nodes.push(node);
  return node;
};

const addArtifactIdentityNodes = (
  state: GraphBuildState,
  artifactNode: ApplicationNode,
  parsed: ParsedManagedGraphInput,
): void => {
  const artifact = parsed.artifact?.result;
  const artifactCoverage = managedSourceCoverage(
    parsed.artifact?.result.coverage.state ?? "complete",
  );
  if (artifact?.assembly !== undefined && artifact.assembly !== null) {
    const assembly = createJavaScriptApplicationNode({
      kind: "managed-assembly",
      identity: artifactLocalIdentity(
        state.artifactSha256,
        "managed-assembly",
        artifact.assembly.token,
      ),
      observations: [
        {
          label: artifact.assembly.name,
          properties: {
            name: artifact.assembly.name,
            version: artifact.assembly.version,
            culture: artifact.assembly.culture,
            public_key_kind: artifact.assembly.public_key.kind,
          },
          evidence: managedEvidence(
            state,
            "inspect_managed_artifact",
            artifactCoverage,
          ),
        },
      ],
    });
    state.nodes.push(assembly);
    addContainsEdge(state, artifactNode, assembly, {
      kind: "declares-managed-assembly",
      coverage: artifactCoverage,
    });
  }
  const module =
    artifact?.module ??
    parsed.members?.result.module ??
    parsed.boundaries?.result.module;
  if (module !== undefined && module !== null) {
    const moduleCoverage = managedSourceCoverage(moduleCoverageState(parsed));
    const moduleNode = createJavaScriptApplicationNode({
      kind: "managed-module",
      identity: artifactLocalIdentity(
        state.artifactSha256,
        "managed-module",
        module.mvid ?? module.token,
      ),
      observations: [
        {
          label: module.name,
          properties: {
            name: module.name,
            mvid: module.mvid,
            generation: module.generation,
            token: module.token,
          },
          evidence: managedEvidence(
            state,
            "inspect_managed_artifact",
            moduleCoverage,
          ),
        },
      ],
    });
    state.nodes.push(moduleNode);
    addContainsEdge(state, artifactNode, moduleNode, {
      kind: "declares-managed-module",
      coverage: moduleCoverage,
    });
  }
};

const addMemberNodes = (
  state: GraphBuildState,
  artifactNode: ApplicationNode,
  parsed: ParsedManagedGraphInput,
  limits: ProjectManagedApplicationGraphInput["limits"],
) => {
  const members = parsed.members?.result;
  if (members === undefined) return { types: 0, methods: 0, fields: 0 };
  const types = members.types.items.slice(0, limits.max_types);
  const methods = members.methods.items.slice(0, limits.max_methods);
  const fields = members.fields.items.slice(0, limits.max_fields);
  const typeCoverage = managedSourcePageCoverage(
    members.coverage.state,
    members.types,
    "types",
  );
  const methodCoverage = managedSourcePageCoverage(
    members.coverage.state,
    members.methods,
    "methods",
  );
  const fieldCoverage = managedSourcePageCoverage(
    members.coverage.state,
    members.fields,
    "fields",
  );
  for (const type of types) {
    const node = typeNode(state, type, typeCoverage);
    state.nodes.push(node);
    state.typeNodes.set(type.token, node);
    addContainsEdge(state, artifactNode, node, {
      kind: "declares-managed-type",
      coverage: typeCoverage,
    });
  }
  for (const method of methods) {
    const node = methodNode(state, method, methodCoverage);
    state.nodes.push(node);
    state.methodNodes.set(method.token, node);
    const owner =
      method.declaring_type_token === null
        ? artifactNode
        : (state.typeNodes.get(method.declaring_type_token) ?? artifactNode);
    addContainsEdge(state, owner, node, {
      kind: "declares-managed-method",
      coverage: methodCoverage,
    });
  }
  for (const field of fields) {
    const node = fieldNode(state, field, fieldCoverage);
    state.nodes.push(node);
    state.fieldNodes.set(field.token, node);
    const owner =
      field.declaring_type_token === null
        ? artifactNode
        : (state.typeNodes.get(field.declaring_type_token) ?? artifactNode);
    addContainsEdge(state, owner, node, {
      kind: "declares-managed-field",
      coverage: fieldCoverage,
    });
  }
  return {
    types: types.length,
    methods: methods.length,
    fields: fields.length,
  };
};

const typeNode = (
  state: GraphBuildState,
  type: ManagedType,
  coverage: ApplicationGraphEvidence["coverage"],
): ApplicationNode =>
  createJavaScriptApplicationNode({
    kind: "managed-type",
    identity: artifactLocalIdentity(
      state.artifactSha256,
      "managed-type-token",
      type.token,
    ),
    observations: [
      {
        label: type.full_name,
        properties: {
          token: type.token,
          namespace: type.namespace,
          name: type.name,
          full_name: type.full_name,
          flags: type.flags,
          extends_token: type.extends_token,
        },
        evidence: managedEvidence(state, "inspect_managed_members", coverage),
      },
    ],
  });

const methodNode = (
  state: GraphBuildState,
  method: ManagedMethod,
  coverage: ApplicationGraphEvidence["coverage"],
): ApplicationNode =>
  createJavaScriptApplicationNode({
    kind: "managed-method",
    identity: artifactLocalIdentity(
      state.artifactSha256,
      "managed-method-token",
      method.token,
    ),
    observations: [
      {
        label:
          method.declaring_type === null
            ? method.name
            : `${method.declaring_type}.${method.name}`,
        properties: {
          token: method.token,
          declaring_type_token: method.declaring_type_token,
          declaring_type: method.declaring_type,
          name: method.name,
          rva: method.rva,
          signature_sha256: method.signature.raw_sha256,
          signature_status: method.signature.parse_status,
          body_status: method.body.status,
          normalized_il_sha256: method.body.normalized_il_sha256,
          il_size: method.body.il_size,
        },
        evidence: managedEvidence(state, "inspect_managed_members", coverage),
      },
    ],
  });

const fieldNode = (
  state: GraphBuildState,
  field: ManagedField,
  coverage: ApplicationGraphEvidence["coverage"],
): ApplicationNode =>
  createJavaScriptApplicationNode({
    kind: "managed-field",
    identity: artifactLocalIdentity(
      state.artifactSha256,
      "managed-field-token",
      field.token,
    ),
    observations: [
      {
        label:
          field.declaring_type === null
            ? field.name
            : `${field.declaring_type}.${field.name}`,
        properties: {
          token: field.token,
          declaring_type_token: field.declaring_type_token,
          declaring_type: field.declaring_type,
          name: field.name,
          flags: field.flags,
          signature_sha256: field.signature.raw_sha256,
          signature_status: field.signature.parse_status,
        },
        evidence: managedEvidence(state, "inspect_managed_members", coverage),
      },
    ],
  });

const addBoundaryNodes = (
  state: GraphBuildState,
  artifactNode: ApplicationNode,
  parsed: ParsedManagedGraphInput,
  limits: ProjectManagedApplicationGraphInput["limits"],
) => {
  const boundaries = parsed.boundaries?.result;
  if (boundaries === undefined)
    return { pinvoke_imports: 0, native_implementations: 0 };
  const pinvokes = boundaries.pinvoke_imports.items.slice(
    0,
    limits.max_pinvoke_imports,
  );
  const implementations = boundaries.native_implementations.items.slice(
    0,
    limits.max_native_implementations,
  );
  const pinvokeCoverage = managedSourcePageCoverage(
    boundaries.coverage.state,
    boundaries.pinvoke_imports,
    "pinvoke_imports",
  );
  const implementationCoverage = managedSourcePageCoverage(
    boundaries.coverage.state,
    boundaries.native_implementations,
    "native_implementations",
  );
  for (const pinvoke of pinvokes) {
    const node = pinvokeNode(state, pinvoke, pinvokeCoverage);
    state.nodes.push(node);
    const owner =
      pinvoke.member_token === null
        ? artifactNode
        : (state.methodNodes.get(pinvoke.member_token) ?? artifactNode);
    state.edges.push(
      createJavaScriptApplicationEdge({
        source_node_id: owner.node_id,
        target_node_id: node.node_id,
        relation: "imports",
        properties: {
          kind: "managed-pinvoke",
          import_name: pinvoke.import_name,
          import_scope_name: pinvoke.import_scope_name,
        },
        evidence: managedEvidence(
          state,
          "inspect_managed_native_boundaries",
          pinvokeCoverage,
        ),
      }),
    );
  }
  for (const implementation of implementations) {
    const node = nativeImplementationNode(
      state,
      implementation,
      implementationCoverage,
    );
    state.nodes.push(node);
    const owner = state.methodNodes.get(implementation.token) ?? artifactNode;
    addContainsEdge(state, owner, node, {
      kind: "declares-managed-native-implementation",
      coverage: implementationCoverage,
    });
  }
  return {
    pinvoke_imports: pinvokes.length,
    native_implementations: implementations.length,
  };
};

const pinvokeNode = (
  state: GraphBuildState,
  pinvoke: PinvokeImport,
  coverage: ApplicationGraphEvidence["coverage"],
): ApplicationNode =>
  createJavaScriptApplicationNode({
    kind: "managed-pinvoke-import",
    identity: artifactLocalIdentity(
      state.artifactSha256,
      "managed-pinvoke-token",
      pinvoke.token,
    ),
    observations: [
      {
        label: pinvoke.import_name,
        properties: {
          token: pinvoke.token,
          member_token: pinvoke.member_token,
          member_name: pinvoke.member_name,
          import_name: pinvoke.import_name,
          import_scope_name: pinvoke.import_scope_name,
          char_set: pinvoke.char_set,
          call_convention: pinvoke.call_convention,
          verification: pinvoke.verification,
        },
        evidence: managedEvidence(
          state,
          "inspect_managed_native_boundaries",
          coverage,
        ),
      },
    ],
  });

const nativeImplementationNode = (
  state: GraphBuildState,
  implementation: NativeImplementation,
  coverage: ApplicationGraphEvidence["coverage"],
): ApplicationNode =>
  createJavaScriptApplicationNode({
    kind: "managed-native-implementation",
    identity: artifactLocalIdentity(
      state.artifactSha256,
      "managed-native-implementation-token",
      implementation.token,
    ),
    observations: [
      {
        label: implementation.name,
        properties: {
          token: implementation.token,
          name: implementation.name,
          rva: implementation.rva,
          code_type: implementation.code_type,
          managed_kind: implementation.managed_kind,
          pinvoke_declared: implementation.pinvoke_declared,
          boundary_kind: implementation.boundary_kind,
          body_interpretation: implementation.body_interpretation,
        },
        evidence: managedEvidence(
          state,
          "inspect_managed_native_boundaries",
          coverage,
        ),
      },
    ],
  });

const addContainsEdge = (
  state: GraphBuildState,
  source: ApplicationNode,
  target: ApplicationNode,
  options: ContainsEdgeOptions,
): void => {
  state.edges.push(
    createJavaScriptApplicationEdge({
      source_node_id: source.node_id,
      target_node_id: target.node_id,
      relation: "contains",
      properties: { kind: options.kind },
      evidence: managedEvidence(
        state,
        "project-managed-contains",
        options.coverage,
      ),
    }),
  );
};

const artifactLocalIdentity = (
  artifactSha256: string,
  namespace: string,
  key: string,
) => ({
  strategy: "artifact-local-key" as const,
  stability: "artifact-version" as const,
  artifact_sha256: artifactSha256,
  namespace,
  key,
});

const managedEvidence = (
  state: GraphBuildState,
  operation: string,
  coverage: ApplicationGraphEvidence["coverage"] = completeManagedGraphCoverage(),
): ApplicationGraphEvidence => ({
  authority: "managed-static-analysis",
  state: "observed",
  confidence: "exact",
  artifact: {
    available: true,
    artifact_id: `art_${state.artifactSha256}`,
    sha256: state.artifactSha256,
  },
  location: {
    available: true,
    value: {
      kind: "artifact-path",
      path: graphArtifactPath(state.artifactPath),
    },
  },
  extractor: {
    name: "rea-dotnet-static",
    version: "1",
    operation,
    executable_sha256: null,
  },
  coverage,
  limitations:
    coverage.status === "complete"
      ? []
      : [
          "The source managed Evidence slice is incomplete; unreturned or unavailable items remain unobserved.",
        ],
  evidence_ids: state.evidenceLinks,
});

const graphArtifactPath = (path: string): string => {
  const name = basename(path).replaceAll(/[^A-Za-z0-9._-]/gu, "_");
  return `managed/${name.length === 0 ? "artifact.pe" : name}`;
};

const moduleCoverageState = (
  parsed: ParsedManagedGraphInput,
): "complete" | "partial" | "unavailable" => {
  const artifact = parsed.artifact;
  if (artifact !== null && artifact.result.module !== null)
    return artifact.result.coverage.state;
  const members = parsed.members;
  if (members !== null && members.result.module !== null)
    return members.result.coverage.state;
  return parsed.boundaries?.result.coverage.state ?? "complete";
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
