import { javascriptSourceRangeKey } from "../../domain/javascript/javascriptSourceCoordinates.js";
import type { ElectronNativeAddonBindingFinding } from "../../domain/javascript/electronStaticAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import {
  artifactLocalIdentity,
  javascriptAnalysisCoverage,
  type JavaScriptArtifactGraphContext,
  type JavaScriptArtifactGraphCoverage,
} from "./JavaScriptArtifactGraphContext.js";
import { compositeKey } from "../../domain/unicodeCodePointOrder.js";
import { javascriptDisplayText } from "../../domain/javascript/javascriptAstValues.js";
import {
  addElectronInferenceEdge,
  electronFindingEvidence,
  electronFindingSourceNode,
  electronObservationIdentity,
} from "./ElectronBoundaryGraphContext.js";
import {
  createElectronNativeAddonResolver,
  type ElectronNativeAddonResolver,
} from "./ElectronBoundaryNativeResolution.js";

interface NativeBindingInput {
  readonly context: JavaScriptArtifactGraphContext;
  readonly resolver: ElectronNativeAddonResolver;
  readonly existingLoadTargets: ReadonlyMap<string, ReadonlySet<string>>;
  readonly file: JavaScriptArtifactFile;
  readonly value: ElectronNativeAddonBindingFinding;
  readonly coverage: JavaScriptArtifactGraphCoverage;
}

/** Project JavaScript-requested native addon binding and re-export surfaces. */
export const addElectronNativeBoundaries = (
  context: JavaScriptArtifactGraphContext,
): void => {
  const existingLoadTargets = collectExistingLoadTargets(context);
  const resolver =
    context.analysis.nativeAddonResolver ??
    createElectronNativeAddonResolver({
      files: context.filesByPath,
      jsonDocuments: context.analysis.jsonDocuments,
      directoryPaths: context.directoryPaths,
      unanalyzedFiles: context.unanalyzedFiles,
    });
  for (const analyzed of context.analysis.files) {
    const { file, javascript } = analyzed;
    if (javascript === null) continue;
    const coverage = javascriptAnalysisCoverage(javascript);
    for (const value of javascript.electron.native_addon_bindings)
      addNativeBinding({
        context,
        resolver,
        existingLoadTargets,
        file,
        value,
        coverage,
      });
  }
};

const addNativeBinding = (input: NativeBindingInput): void => {
  const { context, resolver, existingLoadTargets, file, value, coverage } =
    input;
  const source = electronFindingSourceNode(
    context,
    file,
    value.module_key,
    value.module_runtime,
  );
  if (source === undefined) return;
  const resolvedPaths =
    value.loader_authority === "candidate" ? [] : resolver.resolve(file, value);
  const primaryResolved =
    resolvedPaths.length === 1 ? (resolvedPaths[0] ?? null) : null;
  const bindingKey = compositeKey([
    file.path,
    value.specifier,
    value.binding_kind,
    value.members,
    value.namespace_access ?? null,
    value.dynamic_member_access ?? null,
    javascriptSourceRangeKey(value.location),
  ]);
  const binding = context.accumulator.addNode({
    kind: "native-export",
    identity:
      value.loader_authority === "candidate"
        ? artifactLocalIdentity(
            file.sha256,
            "javascript-requested-native-export",
            bindingKey,
          )
        : electronObservationIdentity(
            context,
            "javascript-requested-native-export",
            bindingKey,
          ),
    observations: [
      {
        label:
          value.members.map(javascriptDisplayText).join(", ") ||
          value.specifier,
        properties: {
          specifier: value.specifier,
          binding_kind: value.binding_kind,
          requested_members: value.members,
          namespace_access: value.namespace_access ?? null,
          dynamic_member_access: value.dynamic_member_access ?? null,
          resolved_path: primaryResolved,
          ...(resolvedPaths.length > 1
            ? { resolved_paths: [...resolvedPaths] }
            : {}),
          native_export_verification: "not-performed",
          ...(value.loader_authority === "candidate"
            ? { loader_authority: "candidate" }
            : {}),
        },
        evidence: electronFindingEvidence(
          {
            sha256: file.sha256,
            path: file.path,
            range: value.location,
            operation: "observe-native-addon-binding",
            coverage,
            limitations: [
              "JavaScript syntax identifies requested member names; it does not prove that the native binary exports or implements them.",
            ],
          },
          value.loader_authority,
        ),
      },
    ],
  });
  addElectronInferenceEdge(context, {
    source,
    target: binding,
    file,
    range: value.location,
    coverage,
    relation: value.binding_kind === "re-export" ? "exposes" : "imports",
    operation: "map-native-addon-binding",
    loaderAuthority: value.loader_authority,
    properties: {
      specifier: value.specifier,
      binding_kind: value.binding_kind,
      requested_members: value.members,
      namespace_access: value.namespace_access ?? null,
      dynamic_member_access: value.dynamic_member_access ?? null,
    },
    limitations: [
      "Requested JavaScript members are not verified native exports.",
    ],
  });
  const sourceExistingLoads = existingLoadTargets.get(source.node_id);
  for (const resolvedPath of resolvedPaths) {
    const addon = context.fileNodes.get(resolvedPath);
    if (addon === undefined) continue;
    addElectronInferenceEdge(context, {
      source: addon,
      target: binding,
      file,
      range: value.location,
      coverage,
      relation: "exposes",
      operation: "associate-native-addon-requested-exports",
      properties: {
        resolved_path: resolvedPath,
        requested_members: value.members,
        namespace_access: value.namespace_access ?? null,
        dynamic_member_access: value.dynamic_member_access ?? null,
        verified: false,
      },
      confidence: "medium",
      limitations: [
        "The .node artifact path is resolved, but requested JavaScript members have not been verified against native symbols.",
      ],
    });
    if (
      source.node_id !== addon.node_id &&
      sourceExistingLoads?.has(addon.node_id) !== true
    ) {
      addElectronInferenceEdge(context, {
        source,
        target: addon,
        file,
        range: value.location,
        coverage,
        relation: "loads",
        operation: "associate-native-addon-load",
        properties: {
          specifier: value.specifier,
          binding_kind: value.binding_kind,
          resolved_path: resolvedPath,
        },
        confidence: "medium",
        limitations: [
          "Static native-addon loader resolution associates candidate .node artifacts without proving host platform selection or runtime execution.",
        ],
      });
    }
  }
};

const collectExistingLoadTargets = (
  context: JavaScriptArtifactGraphContext,
): Map<string, Set<string>> => {
  const bySource = new Map<string, Set<string>>();
  for (const edge of context.accumulator.edges()) {
    if (edge.relation !== "loads") continue;
    let targets = bySource.get(edge.source_node_id);
    if (targets === undefined) {
      targets = new Set();
      bySource.set(edge.source_node_id, targets);
    }
    targets.add(edge.target_node_id);
  }
  return bySource;
};
