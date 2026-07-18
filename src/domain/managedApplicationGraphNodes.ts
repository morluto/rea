import { basename } from "node:path";

import {
  createJavaScriptApplicationEdge,
  createJavaScriptApplicationNode,
  type ApplicationGraphEvidence,
  type ApplicationNode,
} from "./javascriptApplicationGraph.js";
import {
  managedSourceCoverage,
  managedSourcePageCoverage,
  type ManagedGraphProjectionLimits,
} from "./managedApplicationGraphCoverage.js";
import {
  type ManagedMemberInspection,
  type ManagedNativeBoundaryInspection,
} from "./managedArtifact.js";
import type { GraphBuildState, ParsedManagedGraphInput } from "./managedApplicationGraph.js";

type ManagedMethod = ManagedMemberInspection["methods"]["items"][number];
type ManagedField = ManagedMemberInspection["fields"]["items"][number];
type ManagedType = ManagedMemberInspection["types"]["items"][number];
type PinvokeImport =
  ManagedNativeBoundaryInspection["pinvoke_imports"]["items"][number];
type NativeImplementation =
  ManagedNativeBoundaryInspection["native_implementations"]["items"][number];

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
        evidence: managedEvidence(state, "project-managed-artifact"),
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

/** Add managed type, method, and field nodes from member evidence. */
export const addMemberNodes = (
  state: GraphBuildState,
  artifactNode: ApplicationNode,
  parsed: ParsedManagedGraphInput,
  limits: ManagedGraphProjectionLimits,
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

/** Build a managed type application node. */
export const typeNode = (
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

/** Build a managed method application node. */
export const methodNode = (
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

/** Build a managed field application node. */
export const fieldNode = (
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

/** Add P/Invoke import and native implementation boundary nodes. */
export const addBoundaryNodes = (
  state: GraphBuildState,
  artifactNode: ApplicationNode,
  parsed: ParsedManagedGraphInput,
  limits: ManagedGraphProjectionLimits,
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

/** Build a managed P/Invoke import application node. */
export const pinvokeNode = (
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

/** Build a managed native implementation application node. */
export const nativeImplementationNode = (
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

/** Add a contains relationship edge between two nodes. */
export const addContainsEdge = (
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

/** Build an artifact-local key identity for a managed graph entity. */
export const artifactLocalIdentity = (
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
export const managedEvidence = (
  state: GraphBuildState,
  operation: string,
  coverage: ApplicationGraphEvidence["coverage"] = managedSourceCoverage("complete"),
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

/** Sanitize an artifact path into a managed graph location. */
export const graphArtifactPath = (path: string): string => {
  const name = basename(path).replaceAll(/[^A-Za-z0-9._-]/gu, "_");
  return `managed/${name.length === 0 ? "artifact.pe" : name}`;
};

/** Derive the module coverage state from the best available evidence source. */
export const moduleCoverageState = (
  parsed: ParsedManagedGraphInput,
): "complete" | "partial" | "unavailable" =>
  parsed.artifact !== null && parsed.artifact.result.module !== null
    ? parsed.artifact.result.coverage.state
    : parsed.members !== null && parsed.members.result.module !== null
      ? parsed.members.result.coverage.state
      : (parsed.boundaries?.result.coverage.state ?? "complete");
