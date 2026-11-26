import { basename } from "node:path";
import {
  createJavaScriptApplicationEdge,
  createJavaScriptApplicationNode,
} from "../javascript/javascriptApplicationGraph.js";
import type { ApplicationGraphEvidence } from "../javascript/javascriptApplicationEvidenceSchemas.js";
import type { ApplicationNode } from "../javascript/javascriptApplicationGraphSchemas.js";
import { managedSourceCoverage } from "./managedApplicationGraphCoverage.js";
import type { Evidence } from "../evidence.js";
import { managedTokenScopesMatch } from "./managedInspectionEvidence.js";
import type {
  ManagedArtifactInspection,
  ManagedMemberInspection,
  ManagedNativeBoundaryInspection,
} from "./managedArtifact.js";
import type {
  GraphBuildState,
  ParsedManagedGraphInput,
} from "./managedApplicationGraph.js";
type ManagedMethod = ManagedMemberInspection["methods"][number];
type ManagedField = ManagedMemberInspection["fields"][number];
type ManagedType = ManagedMemberInspection["types"][number];
type PinvokeImport = ManagedNativeBoundaryInspection["pinvoke_imports"][number];
type NativeImplementation =
  ManagedNativeBoundaryInspection["native_implementations"][number];

/**
 * Display label for a metadata name. Metadata may hold an empty name; the
 * graph then has no label, while the node's properties keep the source value.
 */
import {
  managedModuleRow,
  type ManagedModuleRow,
} from "./managedModuleIdentity.js";

const metadataLabel = (name: string | null): string | null =>
  name === "" ? null : name;

/** Options for a managed contains relationship edge. */
export interface ContainsEdgeOptions {
  readonly kind: string;
  readonly coverage: ApplicationGraphEvidence["coverage"];
}

/** Add the root managed artifact node to the graph state. */
export const addArtifactNode = (state: GraphBuildState): ApplicationNode => {
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
        evidence: projectedManagedEvidence(state, "project-managed-artifact"),
      },
    ],
  });
  state.nodes.push(node);
  return node;
};

/** Add managed assembly and module identity nodes for the artifact. */
export const addArtifactIdentityNodes = (
  state: GraphBuildState,
  artifactNode: ApplicationNode,
  parsed: ParsedManagedGraphInput,
): void => {
  const artifactInput = parsed.artifact;
  if (artifactInput !== null && artifactInput.result.assembly !== null) {
    const assemblyFacts = artifactInput.result.assembly;
    const artifactEvidence = sourceManagedEvidence(
      state,
      artifactInput.evidence,
      artifactInput.result.coverage.state,
    );
    const assembly = createJavaScriptApplicationNode({
      kind: "managed-assembly",
      identity: artifactLocalIdentity(
        state.artifactSha256,
        "managed-assembly",
        assemblyFacts.token,
      ),
      observations: [
        {
          label: metadataLabel(assemblyFacts.name),
          properties: {
            name: assemblyFacts.name,
            version: assemblyFacts.version,
            culture: assemblyFacts.culture,
            public_key_kind: assemblyFacts.public_key.kind,
          },
          evidence: artifactEvidence,
        },
      ],
    });
    state.nodes.push(assembly);
    addContainsEdge(state, artifactNode, assembly, {
      kind: "declares-managed-assembly",
      coverage: artifactEvidence.coverage,
    });
  }
  const moduleSource = selectModuleSource(parsed);
  if (moduleSource !== null) {
    const { module } = moduleSource;
    const moduleEvidence = sourceManagedEvidence(
      state,
      moduleSource.evidence,
      moduleSource.coverageState,
    );
    const moduleNode = createJavaScriptApplicationNode({
      kind: "managed-module",
      identity: artifactLocalIdentity(
        state.artifactSha256,
        "managed-module",
        module.mvid?.toLowerCase() ?? module.token,
      ),
      observations: [
        {
          label: metadataLabel(module.name),
          properties: {
            name: module.name,
            mvid: module.mvid,
            generation: module.generation,
            token: module.token,
          },
          evidence: moduleEvidence,
        },
      ],
    });
    state.nodes.push(moduleNode);
    addContainsEdge(state, artifactNode, moduleNode, {
      kind: "declares-managed-module",
      coverage: moduleEvidence.coverage,
    });
  }
};

interface ManagedModuleSource {
  readonly module: ManagedModuleRow;
  readonly evidence: Evidence;
  readonly coverageState: ManagedArtifactInspection["coverage"]["state"];
}

const selectModuleSource = (
  parsed: ParsedManagedGraphInput,
): ManagedModuleSource | null => {
  const sources: ManagedModuleSource[] = [];
  for (const source of [parsed.artifact, parsed.members, parsed.boundaries]) {
    if (source === null) continue;
    const module = managedModuleRow(source.result);
    if (module !== null)
      sources.push({
        module,
        evidence: source.evidence,
        coverageState: source.result.coverage.state,
      });
  }
  return (
    sources.find(
      ({ module }) => module.mvid !== null && module.name !== null,
    ) ??
    sources.find(({ module }) => module.mvid !== null) ??
    sources.find(({ module }) => module.name !== null) ??
    sources[0] ??
    null
  );
};

/** Add managed type, method, and field nodes from member evidence. */
export const addMemberNodes = (
  state: GraphBuildState,
  artifactNode: ApplicationNode,
  parsed: ParsedManagedGraphInput,
): void => {
  const memberInput = parsed.members;
  if (memberInput === null) return;
  const members = memberInput.result;
  const { types, methods, fields } = members;
  const sourceEvidence = sourceManagedEvidence(
    state,
    memberInput.evidence,
    members.coverage.state,
  );
  for (const type of types) {
    const node = typeNode(state, type, sourceEvidence);
    state.nodes.push(node);
    state.typeNodes.set(type.token, node);
    addContainsEdge(state, artifactNode, node, {
      kind: "declares-managed-type",
      coverage: sourceEvidence.coverage,
    });
  }
  const addMember = (
    kind: "managed-method" | "managed-field",
    member: ManagedMethod | ManagedField,
    details: ApplicationNode["observations"][number]["properties"],
  ): void => {
    const node = createJavaScriptApplicationNode({
      kind,
      identity: artifactLocalIdentity(
        state.artifactSha256,
        `${kind}-token`,
        member.token,
      ),
      observations: [
        {
          label: metadataLabel(
            member.declaring_type === null
              ? member.name
              : `${member.declaring_type}.${member.name}`,
          ),
          properties: {
            token: member.token,
            declaring_type_token: member.declaring_type_token,
            declaring_type: member.declaring_type,
            name: member.name,
            ...details,
          },
          evidence: sourceEvidence,
        },
      ],
    });
    state.nodes.push(node);
    const nodes =
      kind === "managed-method" ? state.methodNodes : state.fieldNodes;
    nodes.set(member.token, node);
    const owner =
      member.declaring_type_token === null
        ? artifactNode
        : (state.typeNodes.get(member.declaring_type_token) ?? artifactNode);
    addContainsEdge(state, owner, node, {
      kind: `declares-${kind}`,
      coverage: sourceEvidence.coverage,
    });
  };
  for (const method of methods) {
    addMember("managed-method", method, {
      rva: method.rva,
      signature_sha256: method.signature.raw_sha256,
      signature_status: method.signature.parse_status,
      body_status: method.body.status,
      normalized_il_sha256: method.body.normalized_il_sha256,
      il_size: method.body.il_size,
    });
  }
  for (const field of fields) {
    addMember("managed-field", field, {
      flags: field.flags,
      signature_sha256: field.signature.raw_sha256,
      signature_status: field.signature.parse_status,
    });
  }
};

/** Build a managed type application node. */
const typeNode = (
  state: GraphBuildState,
  type: ManagedType,
  evidence: ApplicationGraphEvidence,
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
        label: metadataLabel(type.full_name),
        properties: {
          token: type.token,
          namespace: type.namespace,
          name: type.name,
          full_name: type.full_name,
          flags: type.flags,
          extends_token: type.extends_token,
        },
        evidence,
      },
    ],
  });

/** Add P/Invoke import and native implementation boundary nodes. */
export const addBoundaryNodes = (
  state: GraphBuildState,
  artifactNode: ApplicationNode,
  parsed: ParsedManagedGraphInput,
): void => {
  const boundaryInput = parsed.boundaries;
  if (boundaryInput === null) return;
  const boundaries = boundaryInput.result;
  const { pinvoke_imports: pinvokes, native_implementations: implementations } =
    boundaries;
  const pinvokeCoverage = managedSourceCoverage(boundaries.coverage.state);
  const implementationCoverage = managedSourceCoverage(
    boundaries.coverage.state,
  );
  const sourceEvidence = sourceManagedEvidence(
    state,
    boundaryInput.evidence,
    boundaries.coverage.state,
  );
  const canJoinMemberTokens =
    parsed.members !== null &&
    managedTokenScopesMatch(
      parsed.members.result.identity_scope.requires_mvid,
      boundaries.identity_scope.requires_mvid,
    );
  for (const pinvoke of pinvokes) {
    const node = pinvokeNode(state, pinvoke, sourceEvidence);
    state.nodes.push(node);
    const method =
      pinvoke.member_token === null || !canJoinMemberTokens
        ? undefined
        : state.methodNodes.get(pinvoke.member_token);
    const memberEvidence =
      method === undefined || parsed.members === null
        ? undefined
        : parsed.members.evidence;
    const owner = method ?? artifactNode;
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
        evidence: pinvokeAssociationEvidence(
          state,
          boundaryInput.evidence,
          pinvokeCoverage,
          memberEvidence,
        ),
      }),
    );
  }
  for (const implementation of implementations) {
    const node = nativeImplementationNode(
      state,
      implementation,
      sourceEvidence,
    );
    state.nodes.push(node);
    const owner =
      (canJoinMemberTokens
        ? state.methodNodes.get(implementation.token)
        : undefined) ?? artifactNode;
    addContainsEdge(state, owner, node, {
      kind: "declares-managed-native-implementation",
      coverage: implementationCoverage,
    });
  }
};

/** Build a managed P/Invoke import application node. */
const pinvokeNode = (
  state: GraphBuildState,
  pinvoke: PinvokeImport,
  evidence: ApplicationGraphEvidence,
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
        label: metadataLabel(pinvoke.import_name),
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
        evidence,
      },
    ],
  });

/** Build a managed native implementation application node. */
const nativeImplementationNode = (
  state: GraphBuildState,
  implementation: NativeImplementation,
  evidence: ApplicationGraphEvidence,
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
        label: metadataLabel(implementation.name),
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
        evidence,
      },
    ],
  });

/** Add a contains relationship edge between two nodes. */
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
      evidence: projectedManagedEvidence(
        state,
        "project-managed-contains",
        options.coverage,
      ),
    }),
  );
};

/** Build an artifact-local key identity for a managed graph entity. */
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

/** Build managed static-analysis evidence for a graph observation. */
export const sourceManagedEvidence = (
  state: GraphBuildState,
  source: Evidence,
  coverageState: ManagedArtifactInspection["coverage"]["state"],
): ApplicationGraphEvidence =>
  createManagedEvidence(
    state,
    source.operation,
    managedSourceCoverage(coverageState),
    [source.evidence_id],
  );

const projectedManagedEvidence = (
  state: GraphBuildState,
  operation: string,
  coverage: ApplicationGraphEvidence["coverage"] = managedSourceCoverage(
    "complete",
  ),
): ApplicationGraphEvidence =>
  createManagedEvidence(state, operation, coverage, state.evidenceLinks);

const pinvokeAssociationEvidence = (
  state: GraphBuildState,
  boundaryEvidence: Evidence,
  coverage: ApplicationGraphEvidence["coverage"],
  memberEvidence: Evidence | undefined,
): ApplicationGraphEvidence =>
  createManagedEvidence(state, boundaryEvidence.operation, coverage, [
    boundaryEvidence.evidence_id,
    ...(memberEvidence === undefined ? [] : [memberEvidence.evidence_id]),
  ]);

const createManagedEvidence = (
  state: GraphBuildState,
  operation: string,
  coverage: ApplicationGraphEvidence["coverage"],
  evidenceIds: readonly string[],
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
  evidence_ids: [...evidenceIds],
});

/** Sanitize an artifact path into a managed graph location. */
const graphArtifactPath = (path: string): string => {
  const name = basename(path).replaceAll(/[^A-Za-z0-9._-]/gu, "_");
  return `managed/${name.length === 0 ? "artifact.pe" : name}`;
};
