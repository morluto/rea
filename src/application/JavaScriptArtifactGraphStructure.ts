import type { ArtifactInventorySnapshot } from "./ArtifactInventory.js";
import type { ApplicationNode } from "../domain/javascriptApplicationGraph.js";
import type { JavaScriptBundlerRegistration } from "../domain/javascriptStaticAnalysisTypes.js";
import type { JavaScriptArtifactAnalysis } from "./JavaScriptArtifactAnalysisTypes.js";
import type {
  JavaScriptArtifactContainer,
  JavaScriptArtifactFile,
} from "./JavaScriptArtifactFiles.js";
import type { JavaScriptArtifactGraphAccumulator } from "./JavaScriptArtifactGraphAccumulator.js";
import {
  addArtifactContainsEdge,
  addAstContainsEdge,
  addUnavailableStaticParseScope,
  artifactFileNodeKind,
  artifactLocalIdentity,
  chunkLookupKey,
  createElectronRoleNode,
  javascriptAnalysisCoverage,
  linkElectronRoleToAsset,
  moduleLookupKey,
  type JavaScriptArtifactGraphContext,
  type JavaScriptArtifactGraphCoverage,
} from "./JavaScriptArtifactGraphContext.js";
import {
  artifactObservationEvidence,
  astObservationEvidence,
  completeReconstructionCoverage,
  staticInferenceEvidence,
} from "./JavaScriptArtifactGraphEvidence.js";
import { resolveArtifactPathByContext } from "./JavaScriptArtifactPathResolution.js";

interface PackageRoleInput {
  readonly packageNode: ApplicationNode;
  readonly packageFile: JavaScriptArtifactFile;
  readonly kind: "electron-main" | "electron-renderer";
  readonly declaredPath: string | null;
}

/** Create the exact root artifact node from the inventory manifest. */
export const createJavaScriptArtifactRootNode = (
  accumulator: JavaScriptArtifactGraphAccumulator,
  snapshot: ArtifactInventorySnapshot,
): ApplicationNode => {
  const root = snapshot.nodes.find(
    ({ artifact_id: id }) => id === snapshot.manifest.root_artifact_id,
  );
  if (root === undefined)
    throw new TypeError("Artifact inventory root is missing");
  return accumulator.addNode({
    kind: "artifact",
    identity: {
      strategy: "content-digest",
      stability: "global-exact",
      sha256: root.sha256,
    },
    observations: [
      {
        label: "artifact root",
        properties: {
          format: snapshot.manifest.root_format,
          bytes: root.size,
          inventory_manifest_id: snapshot.manifest.manifest_id,
          inventory_graph_sha256: snapshot.manifest.graph_sha256,
          inventory_artifact_id: root.artifact_id,
        },
        evidence: artifactObservationEvidence({
          sha256: root.sha256,
          path: "artifact-root",
          operation: "inventory-root",
          coverage: completeReconstructionCoverage(),
          limitations: [
            "artifact-root is a path-independent alias; the application result retains the canonical local input path.",
          ],
        }),
      },
    ],
  });
};

/** Project nested ASAR containers inventoried inside a directory. */
export const addJavaScriptArtifactContainers = (
  context: JavaScriptArtifactGraphContext,
): void => {
  for (const container of context.fileSet.containers) {
    const node = context.accumulator.addNode({
      kind: "artifact",
      identity: {
        strategy: "content-digest",
        stability: "global-exact",
        sha256: container.sha256,
      },
      observations: [
        {
          label: container.path,
          properties: containerProperties(container),
          evidence: artifactObservationEvidence({
            sha256: container.sha256,
            path: container.path,
            operation: "inventory-nested-asar",
            coverage: completeReconstructionCoverage(),
          }),
        },
      ],
    });
    context.containerNodes.set(container.sha256, node);
    context.accumulator.addEdge({
      source_node_id: context.root.node_id,
      target_node_id: node.node_id,
      relation: "contains",
      properties: { path: container.path, format: "asar" },
      evidence: artifactObservationEvidence({
        sha256: context.snapshot.manifest.root_sha256,
        path: container.path,
        operation: "inventory-nested-asar",
        coverage: completeReconstructionCoverage(),
      }),
    });
  }
};

/** Project relevant files, ASAR entries, and explicit unavailable parse scopes. */
export const addJavaScriptArtifactFiles = (
  context: JavaScriptArtifactGraphContext,
): void => {
  for (const analyzed of context.analysis.files) {
    const { file } = analyzed;
    const target = createFileTarget(context, file, analyzed.javascript);
    context.fileNodes.set(file.path, target);
    if (file.kind === "javascript") context.assetNodes.set(file.path, target);
    const entry = createAsarEntry(context, file);
    const parent =
      context.containerNodes.get(file.container_sha256) ?? context.root;
    if (entry === undefined)
      addArtifactContainsEdge(context, {
        source: parent,
        target,
        file,
        operation: "inventory-file",
      });
    else {
      addArtifactContainsEdge(context, {
        source: parent,
        target: entry,
        file,
        operation: "inventory-entry",
      });
      context.accumulator.addEdge({
        source_node_id: entry.node_id,
        target_node_id: target.node_id,
        relation: "maps_to",
        properties: { sha256: file.sha256 },
        evidence: artifactObservationEvidence({
          sha256: file.container_sha256,
          path: file.path,
          operation: "map-entry-content",
          coverage: completeReconstructionCoverage(),
        }),
      });
    }
    if (
      file.kind === "javascript" &&
      (analyzed.javascript === null ||
        analyzed.javascript.parse_status === "failed")
    )
      addUnavailableStaticParseScope(context, {
        file,
        asset: target,
        operation: "parse-javascript",
        limitation: file.text.included
          ? "JavaScript syntax could not be parsed."
          : `JavaScript text was unavailable: ${file.text.reason}.`,
      });
    const packageValue = context.analysis.packages.find(
      ({ path }) => path === file.path,
    );
    if (
      packageValue?.status !== undefined &&
      packageValue.status !== "included"
    )
      addUnavailableStaticParseScope(context, {
        file,
        asset: target,
        operation: "parse-package-json",
        limitation:
          packageValue.limitation ?? "Package metadata could not be parsed.",
      });
    const jsonValue = context.analysis.json_modules.find(
      ({ path }) => path === file.path,
    );
    if (jsonValue !== undefined && jsonValue.status !== "included")
      addUnavailableStaticParseScope(context, {
        file,
        asset: target,
        operation: "parse-json-module",
        limitation:
          jsonValue.limitation ?? "JSON module content could not be parsed.",
      });
    const sourceMap = context.analysis.source_maps.find(
      ({ path }) => path === file.path,
    );
    if (
      sourceMap !== undefined &&
      (sourceMap.status === "invalid" || sourceMap.status === "not-approved")
    )
      addUnavailableStaticParseScope(context, {
        file,
        asset: target,
        operation: "parse-local-source-map",
        limitation:
          sourceMap.limitation ?? "Source-map content could not be parsed.",
      });
  }
};

/** Project package metadata and its declared Electron roles. */
export const addJavaScriptPackageNodes = (
  context: JavaScriptArtifactGraphContext,
): ApplicationNode[] => {
  const roots: ApplicationNode[] = [];
  for (const packageValue of context.analysis.packages) {
    const file = context.filesByPath.get(packageValue.path);
    if (file === undefined) continue;
    const node = context.accumulator.addNode({
      kind: "package",
      identity: artifactLocalIdentity(file.sha256, "package-json", file.path),
      observations: [
        {
          label: packageValue.name ?? file.path,
          properties: {
            path: file.path,
            name: packageValue.name,
            version: packageValue.version,
            main: packageValue.main,
            renderer: packageValue.renderer,
            parse_status: packageValue.status,
          },
          evidence: artifactObservationEvidence({
            sha256: file.sha256,
            path: file.path,
            operation: "parse-package-json",
            coverage: completeReconstructionCoverage(),
            limitations:
              packageValue.limitation === null ? [] : [packageValue.limitation],
          }),
        },
      ],
    });
    if (roots.length === 0) {
      roots.push(node);
      context.accumulator.addEdge({
        source_node_id: node.node_id,
        target_node_id: context.root.node_id,
        relation: "contains",
        properties: { basis: "package-metadata-within-artifact" },
        evidence: staticInferenceEvidence({
          sha256: file.sha256,
          path: file.path,
          operation: "associate-package-artifact",
          coverage: completeReconstructionCoverage(),
        }),
      });
    } else
      addArtifactContainsEdge(context, {
        source: context.root,
        target: node,
        file,
        operation: "inventory-package",
      });
    addPackageRole(context, {
      packageNode: node,
      packageFile: file,
      kind: "electron-main",
      declaredPath: packageValue.main,
    });
    addPackageRole(context, {
      packageNode: node,
      packageFile: file,
      kind: "electron-renderer",
      declaredPath: packageValue.renderer,
    });
  }
  return roots;
};

/** Project Webpack/Rspack chunk and factory literals recovered from AST. */
export const addJavaScriptBundlerNodes = (
  context: JavaScriptArtifactGraphContext,
): void => {
  for (const analyzed of context.analysis.files) {
    const { file, javascript } = analyzed;
    const asset = context.assetNodes.get(file.path);
    if (javascript === null || asset === undefined) continue;
    const coverage = javascriptAnalysisCoverage(javascript, context.input);
    const records: BundlerGraphRecord[] = [];
    for (const registration of javascript.bundler_registrations) {
      const input = {
        file,
        registration,
        coverage,
        limitations: javascript.limitations,
      };
      const chunk = createBundlerChunkNode(context, input);
      addAstContainsEdge(context, {
        source: asset,
        target: chunk,
        file,
        range: registration.location,
        coverage,
        properties: { bundler: registration.bundler },
      });
      for (const key of registration.chunk_keys)
        context.chunkNodes.set(
          chunkLookupKey(file.path, registration.runtime, key),
          chunk,
        );
      records.push({ file, registration, chunk, coverage });
      addBundlerModuleNodes(context, { ...input, chunk });
    }
    for (const record of records) addBundlerRuntimeEdges(context, record);
  }
};

interface BundlerProjectionInput {
  readonly file: JavaScriptArtifactFile;
  readonly registration: JavaScriptBundlerRegistration;
  readonly coverage: JavaScriptArtifactGraphCoverage;
  readonly limitations: readonly string[];
}

interface BundlerModuleProjectionInput extends BundlerProjectionInput {
  readonly chunk: ApplicationNode;
}

const createBundlerChunkNode = (
  context: JavaScriptArtifactGraphContext,
  input: BundlerProjectionInput,
): ApplicationNode => {
  const { file, registration, coverage, limitations } = input;
  const chunkKey = `${registration.runtime}:${registration.chunk_keys.join(",")}`;
  return context.accumulator.addNode({
    kind: "javascript-chunk",
    identity: artifactLocalIdentity(file.sha256, "bundler-chunk", chunkKey),
    observations: [
      {
        label: chunkKey,
        properties: {
          path: file.path,
          bundler: registration.bundler,
          runtime: registration.runtime,
          chunk_keys: registration.chunk_keys,
          omitted_chunk_keys: registration.omitted_chunk_keys,
          unknown_chunk_keys: registration.unknown_chunk_keys,
          runtime_require_name: registration.runtime_require_name,
          runtime_module_cache_status: registration.runtime_module_cache_status,
          entry_module_keys: registration.entry_module_keys,
          omitted_entry_module_keys: registration.omitted_entry_module_keys,
          unknown_entry_module_keys: registration.unknown_entry_module_keys,
          async_chunk_keys: registration.async_chunk_keys,
          omitted_async_chunk_keys: registration.omitted_async_chunk_keys,
          unknown_async_chunk_keys: registration.unknown_async_chunk_keys,
          module_count: registration.modules.length,
        },
        evidence: astObservationEvidence({
          sha256: file.sha256,
          path: file.path,
          range: registration.location,
          operation: "extract-bundler-registration",
          coverage,
          limitations,
        }),
      },
    ],
  });
};

const addBundlerModuleNodes = (
  context: JavaScriptArtifactGraphContext,
  input: BundlerModuleProjectionInput,
): void => {
  const { file, registration, chunk, coverage, limitations } = input;
  for (const moduleValue of registration.modules) {
    const module = context.accumulator.addNode({
      kind: "javascript-module",
      identity: artifactLocalIdentity(
        file.sha256,
        `${registration.runtime}:module`,
        moduleValue.module_key,
      ),
      observations: [
        {
          label: moduleValue.module_key,
          properties: {
            path: file.path,
            bundler: registration.bundler,
            runtime: registration.runtime,
            chunk_keys: registration.chunk_keys,
            module_key: moduleValue.module_key,
            factory_require_name: moduleValue.factory_require_name,
            runtime_entry: registration.entry_module_keys.includes(
              moduleValue.module_key,
            ),
            source_sha256: moduleValue.source_sha256,
            structural_fingerprint_sha256:
              moduleValue.structural_fingerprint_sha256,
            structural_fingerprint_algorithm:
              moduleValue.structural_fingerprint_algorithm,
            structural_fingerprint_status:
              moduleValue.structural_fingerprint_status,
            exports: moduleValue.exports,
            exports_truncated: moduleValue.exports_truncated,
          },
          evidence: astObservationEvidence({
            sha256: file.sha256,
            path: file.path,
            range: moduleValue.location,
            operation: "extract-bundler-module",
            coverage,
            limitations,
          }),
        },
      ],
    });
    context.moduleNodes.set(
      moduleLookupKey(file.path, moduleValue.module_key),
      module,
    );
    addAstContainsEdge(context, {
      source: chunk,
      target: module,
      file,
      range: moduleValue.location,
      coverage,
      properties: {
        bundler: registration.bundler,
        runtime: registration.runtime,
        chunk_keys: registration.chunk_keys,
        module_key: moduleValue.module_key,
      },
    });
  }
};

interface BundlerGraphRecord {
  readonly file: JavaScriptArtifactFile;
  readonly registration: JavaScriptBundlerRegistration;
  readonly chunk: ApplicationNode;
  readonly coverage: JavaScriptArtifactGraphCoverage;
}

const addBundlerRuntimeEdges = (
  context: JavaScriptArtifactGraphContext,
  record: BundlerGraphRecord,
): void => {
  const { file, registration, chunk, coverage } = record;
  for (const moduleKey of registration.entry_module_keys) {
    const resolved = context.moduleNodes.get(
      moduleLookupKey(file.path, moduleKey),
    );
    const target =
      resolved ?? unresolvedBundlerModuleNode(context, record, moduleKey);
    context.accumulator.addEdge({
      source_node_id: chunk.node_id,
      target_node_id: target.node_id,
      relation: "loads",
      properties: {
        kind: "bundler-entry-module",
        bundler: registration.bundler,
        runtime: registration.runtime,
        module_key: moduleKey,
        resolution_status: resolved === undefined ? "not-found" : "resolved",
      },
      evidence: staticInferenceEvidence({
        sha256: file.sha256,
        path: file.path,
        range: registration.location,
        operation: "resolve-bundler-entry-module",
        coverage,
        confidence: resolved === undefined ? "low" : "high",
      }),
    });
  }
  for (const chunkKey of registration.async_chunk_keys) {
    const lookup = chunkLookupKey(file.path, registration.runtime, chunkKey);
    const resolved = context.chunkNodes.get(lookup);
    const target =
      resolved ?? unresolvedBundlerChunkNode(context, record, chunkKey);
    context.accumulator.addEdge({
      source_node_id: chunk.node_id,
      target_node_id: target.node_id,
      relation: "imports",
      properties: {
        kind: "bundler-async-chunk",
        bundler: registration.bundler,
        runtime: registration.runtime,
        chunk_key: chunkKey,
        resolution_status: resolved === undefined ? "not-found" : "resolved",
      },
      evidence: staticInferenceEvidence({
        sha256: file.sha256,
        path: file.path,
        range: registration.location,
        operation: "resolve-bundler-async-chunk",
        coverage,
        confidence: resolved === undefined ? "low" : "high",
      }),
    });
  }
};

const unresolvedBundlerModuleNode = (
  context: JavaScriptArtifactGraphContext,
  record: BundlerGraphRecord,
  moduleKey: string,
): ApplicationNode =>
  context.accumulator.addNode({
    kind: "javascript-module",
    identity: artifactLocalIdentity(
      record.file.sha256,
      `${record.registration.runtime}:unresolved-entry-module`,
      moduleKey,
    ),
    observations: [
      {
        label: moduleKey,
        properties: {
          semantic_role: "bundler-module-reference",
          bundler: record.registration.bundler,
          runtime: record.registration.runtime,
          module_key: moduleKey,
          resolution_status: "not-found",
        },
        evidence: staticInferenceEvidence({
          sha256: record.file.sha256,
          path: record.file.path,
          range: record.registration.location,
          operation: "retain-unresolved-bundler-entry-module",
          coverage: record.coverage,
          confidence: "low",
        }),
      },
    ],
  });

const unresolvedBundlerChunkNode = (
  context: JavaScriptArtifactGraphContext,
  record: BundlerGraphRecord,
  chunkKey: string,
): ApplicationNode =>
  context.accumulator.addNode({
    kind: "javascript-chunk",
    identity: artifactLocalIdentity(
      record.file.sha256,
      `${record.registration.runtime}:unresolved-async-chunk`,
      chunkKey,
    ),
    observations: [
      {
        label: chunkKey,
        properties: {
          semantic_role: "bundler-chunk-reference",
          bundler: record.registration.bundler,
          runtime: record.registration.runtime,
          chunk_key: chunkKey,
          resolution_status: "not-found",
        },
        evidence: staticInferenceEvidence({
          sha256: record.file.sha256,
          path: record.file.path,
          range: record.registration.location,
          operation: "retain-unresolved-bundler-async-chunk",
          coverage: record.coverage,
          confidence: "low",
        }),
      },
    ],
  });

const createFileTarget = (
  context: JavaScriptArtifactGraphContext,
  file: JavaScriptArtifactFile,
  javascript: JavaScriptArtifactAnalysis["files"][number]["javascript"],
): ApplicationNode => {
  const kind = artifactFileNodeKind(file.kind);
  const json = context.analysis.json_modules.find(
    ({ path }) => path === file.path,
  );
  return context.accumulator.addNode({
    kind,
    identity: {
      strategy: "content-digest",
      stability: "global-exact",
      sha256: file.sha256,
    },
    observations: [
      {
        label: file.path,
        properties: {
          path: file.path,
          bytes: file.bytes,
          inventory_artifact_id: file.inventory_artifact_id,
          unpacked: file.unpacked,
          file_kind: file.kind,
          text_status: file.text.included ? "included" : file.text.reason,
          parse_status: javascript?.parse_status ?? null,
          json_parse_status: json?.status ?? null,
          json_top_level_keys: json?.top_level_keys ?? [],
          omitted_json_top_level_keys: json?.omitted_top_level_keys ?? 0,
          vendor_markers: javascript?.vendors ?? [],
        },
        evidence: artifactObservationEvidence({
          sha256: file.sha256,
          path: file.path,
          operation: "inventory-relevant-file",
          coverage: completeReconstructionCoverage(),
        }),
      },
    ],
  });
};

const createAsarEntry = (
  context: JavaScriptArtifactGraphContext,
  file: JavaScriptArtifactFile,
): ApplicationNode | undefined => {
  const isAsar =
    context.snapshot.manifest.root_format === "asar" ||
    file.container_sha256 !== context.snapshot.manifest.root_sha256;
  if (!isAsar) return undefined;
  return context.accumulator.addNode({
    kind: "asar-entry",
    identity: {
      strategy: "canonical-path",
      stability: "artifact-version",
      artifact_sha256: file.container_sha256,
      path: file.path,
    },
    observations: [
      {
        label: file.path,
        properties: {
          entry_sha256: file.sha256,
          bytes: file.bytes,
          unpacked: file.unpacked,
          inventory_artifact_id: file.inventory_artifact_id,
        },
        evidence: artifactObservationEvidence({
          sha256: file.container_sha256,
          path: file.path,
          operation: "inventory-asar-entry",
          coverage: completeReconstructionCoverage(),
        }),
      },
    ],
  });
};

const addPackageRole = (
  context: JavaScriptArtifactGraphContext,
  input: PackageRoleInput,
): void => {
  if (input.declaredPath === null) return;
  const resolution = resolveArtifactPathByContext({
    declaredPath: input.declaredPath,
    sourcePath: input.packageFile.path,
    context: "package-entrypoint",
    files: context.filesByPath,
  });
  const role = createElectronRoleNode(context, {
    kind: input.kind,
    anchor: input.packageFile,
    resolution,
    mechanism:
      input.kind === "electron-main"
        ? "package.json:main"
        : "package.json:renderer",
  });
  context.accumulator.addEdge({
    source_node_id: input.packageNode.node_id,
    target_node_id: role.node_id,
    relation: "loads",
    properties: {
      declared_path: input.declaredPath,
      resolution_context: resolution.resolution_context,
      resolved_path: resolution.resolved_path,
      resolution_status: resolution.resolution_status,
      limitations: resolution.limitations,
    },
    evidence: staticInferenceEvidence({
      sha256: input.packageFile.sha256,
      path: input.packageFile.path,
      operation: "discover-package-entrypoint",
      coverage: completeReconstructionCoverage(),
      limitations: resolution.limitations,
    }),
  });
  linkElectronRoleToAsset(context, {
    role,
    anchor: input.packageFile,
    resolution,
  });
};

const containerProperties = (container: JavaScriptArtifactContainer) => ({
  path: container.path,
  format: "asar",
  bytes: container.bytes,
  inventory_artifact_id: container.inventory_artifact_id,
});
