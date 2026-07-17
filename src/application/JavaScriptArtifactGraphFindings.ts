import type { ApplicationNode } from "../domain/javascriptApplicationGraph.js";
import type { JavaScriptStaticAnalysis } from "../domain/javascriptStaticAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";
import {
  addStaticInferenceEdge,
  artifactLocalIdentity,
  chunkLookupKey,
  createElectronRoleNode,
  javascriptAnalysisCoverage,
  linkElectronRoleToAsset,
  moduleLookupKey,
  resolveArtifactPath,
  sourceNodeFor,
  type JavaScriptArtifactGraphContext,
  type JavaScriptArtifactGraphCoverage,
} from "./JavaScriptArtifactGraphContext.js";
import {
  astObservationEvidence,
  staticInferenceEvidence,
} from "./JavaScriptArtifactGraphEvidence.js";
import { resolveArtifactPathByContext } from "./JavaScriptArtifactPathResolution.js";

type StaticReference = JavaScriptStaticAnalysis["references"][number];
type StaticEndpoint = JavaScriptStaticAnalysis["endpoints"][number];
type StaticStorage = JavaScriptStaticAnalysis["storage"][number];
type StaticRolePath = JavaScriptStaticAnalysis["role_paths"][number];
type StaticSourceMap = JavaScriptStaticAnalysis["source_map_urls"][number];

interface FindingInput<Value> {
  readonly file: JavaScriptArtifactFile;
  readonly asset: ApplicationNode;
  readonly value: Value;
  readonly coverage: JavaScriptArtifactGraphCoverage;
}

interface ResolvedReference {
  readonly path: string;
  readonly file: JavaScriptArtifactFile;
  readonly node: ApplicationNode;
}

/** Project imports, workers, roles, endpoints, storage, and source-map links. */
export const addJavaScriptStaticFindings = (
  context: JavaScriptArtifactGraphContext,
): void => {
  for (const analyzed of context.analysis.files) {
    const { file, javascript } = analyzed;
    const asset = context.assetNodes.get(file.path);
    if (javascript === null || asset === undefined) continue;
    const coverage = javascriptAnalysisCoverage(javascript, context.input);
    for (const value of javascript.references)
      addReference(context, { file, asset, value, coverage });
    for (const value of javascript.endpoints)
      addEndpoint(context, { file, asset, value, coverage });
    for (const value of javascript.storage)
      addStorage(context, { file, asset, value, coverage });
    for (const value of javascript.role_paths)
      addDiscoveredRole(context, { file, asset, value, coverage });
    for (const value of javascript.source_map_urls)
      addSourceMapEdge(context, { file, asset, value, coverage });
  }
};

const addReference = (
  context: JavaScriptArtifactGraphContext,
  input: FindingInput<StaticReference>,
): void => {
  const source =
    sourceNodeFor(context, input.file.path, input.value.module_key) ??
    input.asset;
  const resolved =
    input.value.specifier === null
      ? null
      : resolveReference(context, input.file.path, input.value);
  if (input.value.kind === "worker" || input.value.kind === "service-worker") {
    const worker = context.accumulator.addNode({
      kind: input.value.kind === "worker" ? "worker" : "service-worker",
      identity: artifactLocalIdentity(
        input.file.sha256,
        input.value.kind,
        input.value.specifier ?? input.value.expression ?? "[dynamic]",
      ),
      observations: [
        {
          label: input.value.specifier,
          properties: {
            declared_specifier: input.value.specifier,
            expression: input.value.expression,
            resolved_path: resolved?.path ?? null,
          },
          evidence: staticInferenceEvidence({
            sha256: input.file.sha256,
            path: input.file.path,
            range: input.value.location,
            operation: "discover-worker",
            coverage: input.coverage,
          }),
        },
      ],
    });
    addStaticInferenceEdge(context, {
      source,
      target: worker,
      file: input.file,
      range: input.value.location,
      coverage: input.coverage,
      relation: "loads",
      properties: { kind: input.value.kind },
    });
    if (resolved !== null)
      addStaticInferenceEdge(context, {
        source: worker,
        target: resolved.node,
        file: input.file,
        range: input.value.location,
        coverage: input.coverage,
        relation: "maps_to",
        properties: { resolved_path: resolved.path },
      });
    return;
  }
  const target =
    resolved?.node ??
    unresolvedReferenceNode(context, input.file, input.value, input.coverage);
  addStaticInferenceEdge(context, {
    source,
    target,
    file: input.file,
    range: input.value.location,
    coverage: input.coverage,
    relation: resolved?.file.kind === "native-addon" ? "loads" : "imports",
    properties: {
      kind: input.value.kind,
      specifier: input.value.specifier,
      expression: input.value.expression,
      resolved_path: resolved?.path ?? null,
    },
  });
};

const addEndpoint = (
  context: JavaScriptArtifactGraphContext,
  input: FindingInput<StaticEndpoint>,
): void => {
  const source =
    sourceNodeFor(context, input.file.path, input.value.module_key) ??
    input.asset;
  const node = context.accumulator.addNode({
    kind: "endpoint",
    identity: artifactLocalIdentity(
      input.file.sha256,
      input.value.kind,
      input.value.value,
    ),
    observations: [
      {
        label: input.value.value,
        properties: {
          endpoint_kind: input.value.kind,
          value: input.value.value,
          mechanism: input.value.mechanism,
        },
        evidence: astObservationEvidence({
          sha256: input.file.sha256,
          path: input.file.path,
          range: input.value.location,
          operation: "discover-static-endpoint",
          coverage: input.coverage,
        }),
      },
    ],
  });
  addStaticInferenceEdge(context, {
    source,
    target: node,
    file: input.file,
    range: input.value.location,
    coverage: input.coverage,
    relation: input.value.kind === "route" ? "exposes" : "calls",
    properties: { mechanism: input.value.mechanism },
  });
};

const addStorage = (
  context: JavaScriptArtifactGraphContext,
  input: FindingInput<StaticStorage>,
): void => {
  const source =
    sourceNodeFor(context, input.file.path, input.value.module_key) ??
    input.asset;
  const node = context.accumulator.addNode({
    kind: "storage",
    identity: artifactLocalIdentity(
      input.file.sha256,
      input.value.kind,
      input.value.name ?? input.value.mechanism,
    ),
    observations: [
      {
        label: input.value.name ?? input.value.kind,
        properties: {
          storage_kind: input.value.kind,
          name: input.value.name,
          mechanism: input.value.mechanism,
        },
        evidence: astObservationEvidence({
          sha256: input.file.sha256,
          path: input.file.path,
          range: input.value.location,
          operation: "discover-static-storage",
          coverage: input.coverage,
        }),
      },
    ],
  });
  addStaticInferenceEdge(context, {
    source,
    target: node,
    file: input.file,
    range: input.value.location,
    coverage: input.coverage,
    relation: "persists_to",
    properties: { mechanism: input.value.mechanism },
  });
};

const addDiscoveredRole = (
  context: JavaScriptArtifactGraphContext,
  input: FindingInput<StaticRolePath>,
): void => {
  const resolution = resolveArtifactPathByContext({
    declaredPath: input.value.path,
    sourcePath: input.file.path,
    context: input.value.resolution_context,
    files: context.filesByPath,
  });
  const role = createElectronRoleNode(context, {
    kind:
      input.value.role === "preload" ? "electron-preload" : "electron-renderer",
    anchor: input.file,
    resolution,
    mechanism: input.value.mechanism,
    range: input.value.location,
    coverage: input.coverage,
  });
  const source =
    sourceNodeFor(context, input.file.path, input.value.module_key) ??
    input.asset;
  addStaticInferenceEdge(context, {
    source,
    target: role,
    file: input.file,
    range: input.value.location,
    coverage: input.coverage,
    relation: "loads",
    properties: { mechanism: input.value.mechanism },
  });
  linkElectronRoleToAsset(context, {
    role,
    anchor: input.file,
    resolution,
    range: input.value.location,
    coverage: input.coverage,
  });
};

const addSourceMapEdge = (
  context: JavaScriptArtifactGraphContext,
  input: FindingInput<StaticSourceMap>,
): void => {
  const resolvedPath = resolveArtifactPath(
    input.value.declared_url,
    input.file.path,
    context.filesByPath,
  );
  const resolvedFile =
    resolvedPath === null ? undefined : context.filesByPath.get(resolvedPath);
  const resolvedNode =
    resolvedPath === null ? undefined : context.fileNodes.get(resolvedPath);
  const target =
    resolvedFile?.kind === "source-map" && resolvedNode !== undefined
      ? resolvedNode
      : context.accumulator.addNode({
          kind: "source-map",
          identity: artifactLocalIdentity(
            input.file.sha256,
            "unresolved-source-map",
            input.value.declared_url,
          ),
          observations: [
            {
              label: input.value.declared_url,
              properties: {
                declared_url: input.value.declared_url,
                resolved_path: resolvedPath,
                available: false,
              },
              evidence: staticInferenceEvidence({
                sha256: input.file.sha256,
                path: input.file.path,
                range: input.value.location,
                operation: "discover-source-map",
                coverage: input.coverage,
                confidence: "medium",
                limitations: [
                  "The declared source map was not present in the inventoried artifact.",
                ],
              }),
            },
          ],
        });
  addStaticInferenceEdge(context, {
    source: input.asset,
    target,
    file: input.file,
    range: input.value.location,
    coverage: input.coverage,
    relation: "maps_to",
    properties: {
      declared_url: input.value.declared_url,
      resolved_path: resolvedPath,
    },
  });
};

const resolveReference = (
  context: JavaScriptArtifactGraphContext,
  sourcePath: string,
  reference: StaticReference,
): ResolvedReference | null => {
  const specifier = reference.specifier;
  if (specifier === null) return null;
  const chunk = resolveBundlerChunkReference(context, sourcePath, reference);
  if (chunk !== null) return chunk;
  const module = context.moduleNodes.get(
    moduleLookupKey(sourcePath, specifier),
  );
  if (module !== undefined) {
    const file = context.filesByPath.get(sourcePath);
    return file === undefined
      ? null
      : { path: `${sourcePath}#module:${specifier}`, file, node: module };
  }
  const path = resolveArtifactPath(
    specifier,
    sourcePath,
    context.filesByPath,
    reference.kind === "require"
      ? "require"
      : reference.kind === "static-import" ||
          reference.kind === "dynamic-import"
        ? "import"
        : undefined,
  );
  if (path === null) return null;
  const file = context.filesByPath.get(path);
  const node = context.fileNodes.get(path);
  return file === undefined || node === undefined ? null : { path, file, node };
};

const resolveBundlerChunkReference = (
  context: JavaScriptArtifactGraphContext,
  sourcePath: string,
  reference: StaticReference,
): ResolvedReference | null => {
  const key = reference.specifier?.startsWith("chunk:")
    ? reference.specifier.slice("chunk:".length)
    : null;
  if (key === null) return null;
  const file = context.filesByPath.get(sourcePath);
  if (file === undefined) return null;
  const registrations = context.analysis.files
    .find(({ file: analyzedFile }) => analyzedFile.path === sourcePath)
    ?.javascript?.bundler_registrations.filter(({ modules }) =>
      reference.module_key === null
        ? true
        : modules.some(
            ({ module_key: moduleKey }) => moduleKey === reference.module_key,
          ),
    );
  if (registrations === undefined) return null;
  const candidates = registrations.flatMap(({ runtime }) => {
    const node = context.chunkNodes.get(
      chunkLookupKey(sourcePath, runtime, key),
    );
    return node === undefined ? [] : [node];
  });
  const unique = [
    ...new Map(candidates.map((node) => [node.node_id, node])).values(),
  ];
  if (unique.length !== 1) return null;
  const node = unique[0];
  return node === undefined
    ? null
    : { path: `${sourcePath}#chunk:${key}`, file, node };
};

const unresolvedReferenceNode = (
  context: JavaScriptArtifactGraphContext,
  file: JavaScriptArtifactFile,
  reference: StaticReference,
  coverage: JavaScriptArtifactGraphCoverage,
): ApplicationNode =>
  context.accumulator.addNode({
    kind: "javascript-module",
    identity: artifactLocalIdentity(
      file.sha256,
      "unresolved-reference",
      `${reference.kind}:${reference.specifier ?? reference.expression ?? "[dynamic]"}`,
    ),
    observations: [
      {
        label: reference.specifier,
        properties: {
          reference_kind: reference.kind,
          specifier: reference.specifier,
          expression: reference.expression,
          resolution: "unresolved",
        },
        evidence: staticInferenceEvidence({
          sha256: file.sha256,
          path: file.path,
          range: reference.location,
          operation: "resolve-static-reference",
          coverage,
          confidence: "low",
          limitations: [
            "The static reference could not be resolved within the inventoried artifact.",
          ],
        }),
      },
    ],
  });
