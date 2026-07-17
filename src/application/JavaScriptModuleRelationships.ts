import { posix } from "node:path";

import type { ApplicationNode } from "../domain/javascriptApplicationGraph.js";
import type {
  JavaScriptModuleOrigin,
  JavaScriptSemanticIr,
  JavaScriptSemanticLimits,
  JavaScriptSemanticModuleLink,
} from "../domain/javascriptSemanticIr.js";
import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";
import {
  addAstContainsEdge,
  artifactLocalIdentity,
  type JavaScriptArtifactGraphContext,
  type JavaScriptArtifactGraphCoverage,
} from "./JavaScriptArtifactGraphContext.js";
import {
  astObservationEvidence,
  completeReconstructionCoverage,
  partialReconstructionCoverage,
  staticInferenceEvidence,
} from "./JavaScriptArtifactGraphEvidence.js";
import { resolveArtifactPathByContext } from "./JavaScriptArtifactPathResolution.js";

interface SemanticAnalysis {
  readonly ir: JavaScriptSemanticIr;
  readonly limits: JavaScriptSemanticLimits;
}

interface RelationshipInput {
  readonly context: JavaScriptArtifactGraphContext;
  readonly file: JavaScriptArtifactFile;
  readonly semantic: SemanticAnalysis;
  readonly source: ApplicationNode;
  readonly link: JavaScriptSemanticModuleLink;
}

interface ResolvedModuleTarget {
  readonly node: ApplicationNode;
  readonly path: string | null;
  readonly file: JavaScriptArtifactFile | null;
  readonly status:
    | "resolved"
    | "not-found"
    | "unavailable"
    | "external"
    | "rejected";
  readonly limitations: readonly string[];
}

/** Create one path-scoped source-module identity for every analyzed source file. */
export const addJavaScriptSourceModules = (
  context: JavaScriptArtifactGraphContext,
): void => {
  for (const analyzed of context.analysis.files) {
    const { file, semantic } = analyzed;
    const asset = context.assetNodes.get(file.path);
    const program = semantic?.ir.scopes.find(({ kind }) => kind === "program");
    if (asset === undefined || semantic === null || program === undefined)
      continue;
    const exports = semantic.ir.moduleLinks
      .flatMap(({ exportedName }) =>
        exportedName === null ? [] : [exportedName],
      )
      .sort(compareCodePoints);
    const retainedExports = [...new Set(exports)].slice(0, 128);
    const source = context.accumulator.addNode({
      kind: "javascript-module",
      identity: artifactLocalIdentity(
        file.sha256,
        "source-module",
        `${file.container_sha256}:${file.path}`,
      ),
      observations: [
        {
          label: file.path,
          properties: {
            semantic_role: "source-module",
            path: file.path,
            container_sha256: file.container_sha256,
            logical_module_key: file.path,
            module_format: moduleFormat(file.path, semantic.ir),
            import_relationships: semantic.ir.moduleLinks.filter(
              ({ kind }) => kind === "import" || kind === "require",
            ).length,
            export_relationships: exports.length,
            export_names: retainedExports,
            omitted_export_names: Math.max(
              0,
              exports.length - retainedExports.length,
            ),
          },
          evidence: astObservationEvidence({
            sha256: file.sha256,
            path: file.path,
            range: program.location,
            operation: "recover-source-module",
            coverage: semanticCoverage(semantic),
            limitations: semantic.ir.limitations,
          }),
        },
      ],
    });
    context.sourceModuleNodes.set(file.path, source);
    addAstContainsEdge(context, {
      source: asset,
      target: source,
      file,
      range: program.location,
      coverage: semanticCoverage(semantic),
      properties: { logical_module_key: file.path },
    });
  }
};

/** Compose bounded CommonJS and ESM binding relationships across artifact files. */
export const addJavaScriptModuleRelationships = (
  context: JavaScriptArtifactGraphContext,
): void => {
  for (const analyzed of context.analysis.files) {
    const { file, semantic } = analyzed;
    const source = context.sourceModuleNodes.get(file.path);
    if (semantic === null || source === undefined) continue;
    for (const link of semantic.ir.moduleLinks) {
      const input = { context, file, semantic, source, link };
      if (isExportLink(link)) addExportRelationship(input);
      else if (link.specifier !== null)
        addImportRelationship(input, source, {
          specifier: link.specifier,
          importedPath: link.importedName === null ? [] : [link.importedName],
        });
    }
  }
};

const addExportRelationship = (input: RelationshipInput): void => {
  const { context, file, semantic, source, link } = input;
  if (link.exportedName === null) return;
  const exported = context.accumulator.addNode({
    kind: "javascript-module",
    identity: artifactLocalIdentity(
      file.sha256,
      "module-export",
      `${file.container_sha256}:${file.path}:${link.exportedName}`,
    ),
    observations: [
      {
        label: `${file.path}:${link.exportedName}`,
        properties: {
          semantic_role: "export-binding",
          module_path: file.path,
          relationship_kind: link.kind,
          exported_name: link.exportedName,
          local_name: link.localName,
          imported_name: link.importedName,
          declared_specifier: link.specifier,
        },
        evidence: astObservationEvidence({
          sha256: file.sha256,
          path: file.path,
          range: link.location,
          operation: "recover-module-export",
          coverage: semanticCoverage(semantic),
          limitations: semantic.ir.limitations,
        }),
      },
    ],
  });
  context.accumulator.addEdge({
    source_node_id: source.node_id,
    target_node_id: exported.node_id,
    relation: "exposes",
    properties: relationshipProperties(link, null),
    evidence: relationshipEvidence(input, "expose-module-export", []),
  });
  const origin = moduleOriginForExport(semantic.ir, link);
  if (origin !== null) addImportRelationship(input, exported, origin);
};

const addImportRelationship = (
  input: RelationshipInput,
  source: ApplicationNode,
  origin: JavaScriptModuleOrigin,
): void => {
  const target = resolveModuleTarget(input, origin.specifier);
  input.context.accumulator.addEdge({
    source_node_id: source.node_id,
    target_node_id: target.node.node_id,
    relation: "imports",
    properties: relationshipProperties(input.link, target, origin),
    evidence: relationshipEvidence(
      input,
      "resolve-semantic-module-relationship",
      target.limitations,
      target.status === "resolved"
        ? "high"
        : target.status === "external"
          ? "medium"
          : "low",
    ),
  });
};

const resolveModuleTarget = (
  input: RelationshipInput,
  specifier: string,
): ResolvedModuleTarget => {
  const resolution = resolveArtifactPathByContext({
    declaredPath: specifier,
    sourcePath: input.file.path,
    context: "module-specifier",
    files: input.context.filesByPath,
    moduleKind:
      input.link.kind === "require" || input.link.kind === "commonjs-export"
        ? "require"
        : "import",
  });
  const path = resolution.resolved_path;
  const file = path === null ? undefined : input.context.filesByPath.get(path);
  const node =
    path === null
      ? undefined
      : (input.context.sourceModuleNodes.get(path) ??
        input.context.fileNodes.get(path));
  if (path !== null && file !== undefined && node !== undefined)
    return {
      node,
      path,
      file,
      status: "resolved",
      limitations: resolution.limitations,
    };
  return {
    node: unresolvedModuleNode(input, specifier, resolution.resolution_status),
    path: null,
    file: null,
    status: resolution.resolution_status,
    limitations: resolution.limitations,
  };
};

const unresolvedModuleNode = (
  input: RelationshipInput,
  specifier: string,
  status: ResolvedModuleTarget["status"],
): ApplicationNode =>
  input.context.accumulator.addNode({
    kind: "javascript-module",
    identity: artifactLocalIdentity(
      input.file.sha256,
      "unresolved-semantic-module",
      `${status}:${specifier}`,
    ),
    observations: [
      {
        label: specifier,
        properties: {
          semantic_role: "module-reference",
          declared_specifier: specifier,
          resolution_status: status,
        },
        evidence: staticInferenceEvidence({
          sha256: input.file.sha256,
          path: input.file.path,
          range: input.link.location,
          operation: "retain-unresolved-semantic-module",
          coverage: semanticCoverage(input.semantic),
          confidence: "low",
          limitations: input.semantic.ir.limitations,
        }),
      },
    ],
  });

const moduleOriginForExport = (
  ir: JavaScriptSemanticIr,
  link: JavaScriptSemanticModuleLink,
): JavaScriptModuleOrigin | null => {
  if (link.specifier !== null)
    return {
      specifier: link.specifier,
      importedPath: link.importedName === null ? [] : [link.importedName],
    };
  if (link.localName === null) return null;
  const program = ir.scopes.find(({ kind }) => kind === "program");
  const binding = ir.bindings.find(
    ({ name, scopeId }) =>
      name === link.localName && scopeId === program?.scopeId,
  );
  return binding?.provenance.status === "module" &&
    binding.provenance.origins.length === 1
    ? (binding.provenance.origins[0] ?? null)
    : null;
};

const relationshipProperties = (
  link: JavaScriptSemanticModuleLink,
  target: ResolvedModuleTarget | null,
  origin?: JavaScriptModuleOrigin,
) => ({
  module_link_kind: link.kind,
  specifier: origin?.specifier ?? link.specifier,
  imported_name: origin?.importedPath.at(-1) ?? link.importedName,
  imported_path: origin?.importedPath ?? [],
  local_name: link.localName,
  exported_name: link.exportedName,
  resolved_path: target?.path ?? null,
  resolution_status: target?.status ?? null,
  target_file_kind: target?.file?.kind ?? null,
  target_json_status:
    target?.file?.kind === "json" ? jsonStatus(target.file) : null,
});

const relationshipEvidence = (
  input: RelationshipInput,
  operation: string,
  limitations: readonly string[],
  confidence: "high" | "medium" | "low" = "high",
) =>
  staticInferenceEvidence({
    sha256: input.file.sha256,
    path: input.file.path,
    range: input.link.location,
    operation,
    coverage: semanticCoverage(input.semantic),
    confidence,
    limitations: [...input.semantic.ir.limitations, ...limitations],
  });

const semanticCoverage = (
  semantic: SemanticAnalysis,
): JavaScriptArtifactGraphCoverage => {
  const limits = Object.entries(semantic.limits).map(([name, value]) => ({
    name: `semantic-${camelToKebab(name)}`,
    value,
    unit: "items" as const,
  }));
  if (semantic.ir.coverage.status === "complete")
    return completeReconstructionCoverage(limits);
  return partialReconstructionCoverage(
    limits,
    semantic.ir.coverage.omittedCount,
    semantic.ir.coverage.status === "truncated",
  );
};

const moduleFormat = (
  path: string,
  ir: JavaScriptSemanticIr,
): "commonjs" | "esm" | "mixed" | "unknown" => {
  const extension = posix.extname(path).toLowerCase();
  if (extension === ".mjs") return "esm";
  if (extension === ".cjs") return "commonjs";
  const esm = ir.moduleLinks.some(({ kind }) =>
    ["import", "export", "re-export"].includes(kind),
  );
  const commonJs = ir.moduleLinks.some(({ kind }) =>
    ["require", "commonjs-export"].includes(kind),
  );
  return esm && commonJs
    ? "mixed"
    : esm
      ? "esm"
      : commonJs
        ? "commonjs"
        : "unknown";
};

const jsonStatus = (
  file: JavaScriptArtifactFile,
): "included" | "invalid" | "unavailable" => {
  if (!file.text.included) return "unavailable";
  try {
    JSON.parse(file.text.value);
    return "included";
  } catch {
    return "invalid";
  }
};

const isExportLink = (link: JavaScriptSemanticModuleLink): boolean =>
  link.kind === "export" ||
  link.kind === "re-export" ||
  link.kind === "commonjs-export";

const camelToKebab = (value: string): string =>
  value.replaceAll(/([a-z])([A-Z])/gu, "$1-$2").toLowerCase();

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
