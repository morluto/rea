import { posix } from "node:path";

import {
  compareUnicodeCodePoints,
  compositeKey,
} from "../../domain/unicodeCodePointOrder.js";
import type { ApplicationNode } from "../../domain/javascript/javascriptApplicationGraphSchemas.js";
import {
  completeApplicationCoverage,
  partialApplicationCoverage,
} from "../../domain/javascript/javascriptApplicationEvidenceSchemas.js";
import {
  semanticCoverageResourceLimits,
  semanticResourceLimitCoverage,
} from "../../domain/javascript/javascriptSemanticCoverage.js";
import { semanticResourceLimitReason } from "../../domain/javascript/javascriptSemanticResourceLimits.js";
import type {
  JavaScriptModuleOrigin,
  JavaScriptSemanticModuleLink,
} from "../../domain/javascript/javascriptSemanticIr.js";
import {
  explicitJavaScriptLoaderMode,
  isJsonModuleTarget,
  moduleResolutionModeForJavaScriptReference,
} from "../../domain/javascript/javascriptModuleResolutionMode.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import {
  addAstContainsEdge,
  artifactLocalIdentity,
  fileOccurrenceIdentity,
  type JavaScriptArtifactGraphContext,
  type JavaScriptArtifactGraphCoverage,
} from "./JavaScriptArtifactGraphContext.js";
import {
  astObservationEvidence,
  staticInferenceEvidence,
} from "./JavaScriptArtifactGraphEvidence.js";
import {
  artifactPathResolutionProperties,
  moduleResolutionModeProperties,
  resolveArtifactPathByContext,
  type ArtifactPathResolution,
} from "./JavaScriptArtifactPathResolution.js";
import { projectJavaScriptExportReturnShapes } from "../../domain/javascript/javascriptExportReturnShapeProjection.js";

import type { JavaScriptModuleSemanticIr } from "../../domain/javascript/javascriptModuleSemanticIr.js";

interface SemanticAnalysis {
  readonly ir: JavaScriptModuleSemanticIr;
}

interface RelationshipInput {
  readonly context: JavaScriptArtifactGraphContext;
  readonly file: JavaScriptArtifactFile;
  readonly semantic: SemanticAnalysis;
  readonly source: ApplicationNode;
  readonly link: JavaScriptSemanticModuleLink;
}

type ResolvedModuleTarget = {
  readonly node: ApplicationNode;
  readonly limitations: readonly string[];
  readonly jsonStatus: "included" | "invalid" | "unavailable" | null;
  readonly resolution?: ArtifactPathResolution;
} & (
  | {
      readonly path: string;
      readonly file: JavaScriptArtifactFile;
      readonly status: "resolved";
    }
  | {
      readonly path: null;
      readonly file: null;
      readonly status: Exclude<
        ArtifactPathResolution["resolution_status"],
        "resolved"
      >;
    }
);

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
      .flatMap(({ exportedName, kind, loaderAuthority }) =>
        exportedName === null ||
        kind === "type-import" ||
        loaderAuthority === "candidate"
          ? []
          : [exportedName],
      )
      .sort(compareUnicodeCodePoints);
    const typeExports = semantic.ir.moduleLinks
      .flatMap(({ exportedName, kind }) =>
        exportedName === null || kind !== "type-import" ? [] : [exportedName],
      )
      .sort(compareUnicodeCodePoints);
    const retainedExportSet = new Set(exports);
    const retainedExports = [...retainedExportSet];
    const candidateExportNames = new Set(
      semantic.ir.moduleLinks.flatMap(({ exportedName, loaderAuthority }) =>
        exportedName !== null &&
        loaderAuthority === "candidate" &&
        !retainedExportSet.has(exportedName)
          ? [exportedName]
          : [],
      ),
    );
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
            file_occurrence: fileOccurrenceIdentity(file),
            source_sha256: file.sha256,
            path: file.path,
            logical_module_key: file.path,
            module_format: moduleFormat(file.path, semantic.ir),
            import_relationships: semantic.ir.moduleLinks.filter(
              ({ kind }) => kind === "import" || kind === "require",
            ).length,
            type_relationships: semantic.ir.moduleLinks.filter(
              ({ kind }) => kind === "type-import",
            ).length,
            export_relationships: exports.length,
            export_names: retainedExports,
            type_export_names: [...new Set(typeExports)],
            omitted_export_names: candidateExportNames.size,
          },
          evidence: astObservationEvidence({
            sha256: file.sha256,
            path: file.path,
            range: program.location,
            operation: "recover-source-module",
            coverage: semanticCoverage(semantic),
            limitations: [
              ...semantic.ir.limitations,
              ...(candidateExportNames.size === 0
                ? []
                : [
                    "Candidate CommonJS export names are not included in the proven export names; the candidate relationships are retained separately.",
                  ]),
            ],
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

/** Relationship compositions the application graph cannot represent, for disclosure. */
export interface JavaScriptModuleRelationshipOmissions {
  /** Import specifiers that resolved back to the importing module itself. */
  readonly selfImports: number;
}

type RelationshipOmissionCounter = { selfImports: number };

/** Compose bounded CommonJS and ESM binding relationships across artifact files. */
export function* addJavaScriptModuleRelationshipsSteps(
  context: JavaScriptArtifactGraphContext,
): Generator<void, JavaScriptModuleRelationshipOmissions> {
  const omissions = { selfImports: 0 };
  for (const analyzed of context.analysis.files) {
    const { file, semantic } = analyzed;
    const source = context.sourceModuleNodes.get(file.path);
    if (semantic === null || source === undefined) continue;
    for (const link of semantic.ir.moduleLinks) {
      // One module can export thousands of bindings, each with return shapes.
      yield;
      if (link.kind === "type-import") continue;
      const input = { context, file, semantic, source, link };
      if (isExportLink(link)) addExportRelationship(input, omissions);
      else if (link.specifier !== null)
        addImportRelationship(input, source, omissions, {
          specifier: link.specifier,
          importedPath: link.importedName === null ? [] : [link.importedName],
        });
    }
  }
  return omissions;
}

const addExportRelationship = (
  input: RelationshipInput,
  omissions: RelationshipOmissionCounter,
): void => {
  const { context, file, semantic, source, link } = input;
  if (link.exportedName === null) return;
  const baseCoverage = semanticCoverage(semantic);
  const candidate = link.loaderAuthority === "candidate";
  const candidateLimitation =
    "The module wrapper is unknown, so this export is only a candidate.";
  const returnShapes = candidate
    ? null
    : projectJavaScriptExportReturnShapes({
        ir: semantic.ir,
        link,
        modulePath: file.path,
        baseCoverage,
      });
  const exported = context.accumulator.addNode({
    kind: "javascript-module",
    identity: artifactLocalIdentity(
      file.sha256,
      "module-export",
      compositeKey([file.container_sha256, file.path, link.exportedName]),
    ),
    observations: [
      {
        label: `${file.path}:${link.exportedName}`,
        properties: {
          semantic_role: "export-binding",
          file_occurrence: fileOccurrenceIdentity(file),
          module_path: file.path,
          relationship_kind: link.kind,
          exported_name: link.exportedName,
          local_name: link.localName,
          imported_name: link.importedName,
          declared_specifier: link.specifier,
          ...(candidate ? { loader_authority: "candidate" } : {}),
        },
        evidence: (candidate
          ? staticInferenceEvidence
          : astObservationEvidence)({
          sha256: file.sha256,
          path: file.path,
          range: link.location,
          operation: "recover-module-export",
          coverage: baseCoverage,
          limitations: candidate
            ? [...semantic.ir.limitations, candidateLimitation]
            : semantic.ir.limitations,
          ...(candidate ? { confidence: "low" as const } : {}),
        }),
      },
      ...(returnShapes === null
        ? []
        : [
            {
              label: `${file.path}:${link.exportedName}:return-shapes`,
              properties: returnShapes.properties,
              evidence: staticInferenceEvidence({
                sha256: file.sha256,
                path: file.path,
                range: returnShapes.range,
                operation: "recover-export-return-shapes",
                coverage: returnShapes.coverage,
                limitations: returnShapes.limitations,
              }),
            },
          ]),
    ],
  });
  context.accumulator.addEdge({
    source_node_id: source.node_id,
    target_node_id: exported.node_id,
    relation: "exposes",
    properties: relationshipProperties(link, null),
    evidence: relationshipEvidence(
      input,
      "expose-module-export",
      candidate ? [candidateLimitation] : [],
      candidate ? "low" : "high",
    ),
  });
  const origin = moduleOriginForExport(semantic.ir, link);
  if (origin !== null)
    addImportRelationship(input, exported, omissions, origin);
};

const addImportRelationship = (
  input: RelationshipInput,
  source: ApplicationNode,
  omissions: RelationshipOmissionCounter,
  origin: JavaScriptModuleOrigin,
): void => {
  const target = resolveModuleTarget(input, origin);
  // A specifier that resolves back to the importing module itself (a literal
  // self-import, self-require, or artifact-confined path alias)
  // cannot become an edge: the application graph forbids self-referential
  // edges, and emitting one fails result validation for the whole analysis.
  if (target.node.node_id === source.node_id) {
    omissions.selfImports += 1;
    return;
  }
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
  origin: JavaScriptModuleOrigin,
): ResolvedModuleTarget => {
  const specifier = origin.specifier;
  if (
    input.link.loaderAuthority === "candidate" ||
    origin.loaderAuthority === "candidate"
  ) {
    // The syntax retains a possible dependency, but an unproven wrapper
    // cannot establish the loader or its lookup base.
    const resolution: ArtifactPathResolution = {
      declared_path: specifier,
      resolution_context: "module-specifier",
      resolution_status: "unavailable",
      resolved_path: null,
      limitations: [
        "The module loader is unknown, so this dependency cannot be resolved against the source file.",
      ],
    };
    return {
      node: unresolvedModuleNode(input, specifier, resolution),
      path: null,
      file: null,
      jsonStatus: null,
      status: resolution.resolution_status,
      limitations: resolution.limitations,
      resolution,
    };
  }
  const resolution = resolveArtifactPathByContext({
    declaredPath: specifier,
    sourcePath: input.file.path,
    context: "module-specifier",
    files: input.context.filesByPath,
    jsonDocuments: input.context.analysis.jsonDocuments,
    directoryPaths: input.context.directoryPaths,
    unanalyzedFiles: input.context.unanalyzedFiles,
    moduleKind: moduleResolutionModeForJavaScriptReference(
      input.file.path,
      input.link.kind === "require" || input.link.kind === "commonjs-export"
        ? "require"
        : "static-import",
      input.link.resolutionMode,
    ),
  });
  if (resolution.resolution_status !== "resolved")
    return {
      node: unresolvedModuleNode(input, specifier, resolution),
      path: null,
      file: null,
      jsonStatus: null,
      status: resolution.resolution_status,
      limitations: resolution.limitations,
      resolution,
    };
  const path = resolution.resolved_path;
  const file = input.context.filesByPath.get(path);
  const node =
    input.context.sourceModuleNodes.get(path) ??
    input.context.fileNodes.get(path);
  if (file === undefined || node === undefined)
    throw new TypeError(
      `Resolved artifact path ${path} is absent from its graph context.`,
    );
  return {
    node,
    path,
    file,
    jsonStatus: isJsonModuleTarget(path, file.kind)
      ? input.context.analysis.jsonDocuments.read(file).status
      : null,
    status: "resolved",
    limitations: resolution.limitations,
    resolution,
  };
};

const unresolvedModuleNode = (
  input: RelationshipInput,
  specifier: string,
  resolution: Extract<
    ArtifactPathResolution,
    { resolution_status: Exclude<ResolvedModuleTarget["status"], "resolved"> }
  >,
): ApplicationNode =>
  input.context.accumulator.addNode({
    kind: "javascript-module",
    identity: artifactLocalIdentity(
      input.file.sha256,
      "unresolved-semantic-module",
      `${resolution.resolution_status}:${specifier}`,
    ),
    observations: [
      {
        label: specifier,
        properties: {
          semantic_role: "module-reference",
          declared_specifier: specifier,
          resolution_status: resolution.resolution_status,
          ...artifactPathResolutionProperties(resolution),
        },
        evidence: staticInferenceEvidence({
          sha256: input.file.sha256,
          path: input.file.path,
          range: input.link.location,
          operation: "retain-unresolved-semantic-module",
          coverage: semanticCoverage(input.semantic),
          confidence: "low",
          limitations: [
            ...input.semantic.ir.limitations,
            ...resolution.limitations,
          ],
        }),
      },
    ],
  });

const moduleOriginForExport = (
  ir: JavaScriptModuleSemanticIr,
  link: JavaScriptSemanticModuleLink,
): JavaScriptModuleOrigin | null => {
  if (link.specifier !== null)
    return {
      ...(link.resolutionMode === undefined
        ? {}
        : { resolutionMode: link.resolutionMode }),
      specifier: link.specifier,
      importedPath: link.importedName === null ? [] : [link.importedName],
      ...(link.loaderAuthority === "candidate"
        ? { loaderAuthority: "candidate" as const }
        : {}),
    };
  if (link.localName === null) return null;
  const program = ir.scopes.find(({ kind }) => kind === "program");
  const binding = ir.bindings.find(
    ({ name, scopeId }) =>
      name === link.localName && scopeId === program?.scopeId,
  );
  const provenance = binding?.provenance;
  if (provenance === undefined || provenance.origins.length !== 1) return null;
  const origin = provenance.origins[0];
  return origin !== undefined &&
    (provenance.status === "module" ||
      (provenance.status === "ambiguous" &&
        origin.loaderAuthority === "candidate"))
    ? origin
    : null;
};

const relationshipProperties = (
  link: JavaScriptSemanticModuleLink,
  target: ResolvedModuleTarget | null,
  origin?: JavaScriptModuleOrigin,
) => ({
  module_link_kind: link.kind,
  ...(link.loaderAuthority === "candidate" ||
  origin?.loaderAuthority === "candidate"
    ? { loader_authority: "candidate" }
    : {}),
  ...(link.loaderAuthority === "candidate" ||
  origin?.loaderAuthority === "candidate"
    ? { resolution_mode: null }
    : moduleResolutionModeProperties(link.resolutionMode)),
  specifier: origin?.specifier ?? link.specifier,
  imported_name: origin?.importedPath.at(-1) ?? link.importedName,
  imported_path: origin?.importedPath ?? [],
  local_name: link.localName,
  exported_name: link.exportedName,
  resolved_path: target?.path ?? null,
  resolution_status: target?.status ?? null,
  ...artifactPathResolutionProperties(target?.resolution),
  target_file_kind: target?.file?.kind ?? null,
  target_json_status: target?.jsonStatus ?? null,
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
    limitations: [
      ...input.semantic.ir.limitations,
      ...semanticCoverageResourceLimits(input.semantic.ir.coverage).map(
        semanticResourceLimitReason,
      ),
      ...limitations,
    ],
  });

const semanticCoverage = (
  semantic: SemanticAnalysis,
): JavaScriptArtifactGraphCoverage => {
  const resourceLimits = semanticCoverageResourceLimits(semantic.ir.coverage);
  if (semantic.ir.coverage.status === "complete" && resourceLimits.length === 0)
    return completeApplicationCoverage();
  return partialApplicationCoverage(
    semanticResourceLimitCoverage(resourceLimits),
    semantic.ir.coverage.omittedCount,
  );
};

const moduleFormat = (
  path: string,
  ir: JavaScriptModuleSemanticIr,
): "commonjs" | "esm" | "mixed" | "unknown" => {
  const loader = explicitJavaScriptLoaderMode(path);
  if (loader === "module") return "esm";
  if (loader === "commonjs") return "commonjs";
  const extension = posix.extname(path).toLowerCase();
  if (extension === ".ts" || extension === ".tsx") return "unknown";
  const esm = ir.moduleLinks.some(({ kind }) =>
    ["import", "export", "re-export"].includes(kind),
  );
  const commonJs = ir.moduleLinks.some(
    ({ kind, loaderAuthority }) =>
      loaderAuthority !== "candidate" &&
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

const isExportLink = (link: JavaScriptSemanticModuleLink): boolean =>
  link.kind === "export" ||
  link.kind === "re-export" ||
  link.kind === "commonjs-export";
