import type { ApplicationNode } from "../domain/javascriptApplicationGraph.js";
import type {
  ElectronBrowserWindowFinding,
  ElectronContextBridgeFinding,
  ElectronUtilityProcessFinding,
} from "../domain/electronStaticAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";
import {
  artifactLocalIdentity,
  createElectronRoleNode,
  javascriptAnalysisCoverage,
  linkElectronRoleToAsset,
  type JavaScriptArtifactGraphContext,
  type JavaScriptArtifactGraphCoverage,
} from "./JavaScriptArtifactGraphContext.js";
import { astObservationEvidence } from "./JavaScriptArtifactGraphEvidence.js";
import {
  addElectronAstEdge,
  addElectronInferenceEdge,
  electronFindingSourceNode,
  electronRangeKey,
} from "./ElectronBoundaryGraphContext.js";
import { resolveArtifactPathByContext } from "./JavaScriptArtifactPathResolution.js";

interface FindingInput<Value> {
  readonly context: JavaScriptArtifactGraphContext;
  readonly file: JavaScriptArtifactFile;
  readonly source: ApplicationNode;
  readonly value: Value;
  readonly coverage: JavaScriptArtifactGraphCoverage;
}

/** Project BrowserWindow, contextBridge, preload, and utility-process facts. */
export const addElectronWindowBoundaries = (
  context: JavaScriptArtifactGraphContext,
): void => {
  for (const analyzed of context.analysis.files) {
    const { file, javascript } = analyzed;
    if (javascript === null) continue;
    const coverage = javascriptAnalysisCoverage(javascript, context.input);
    for (const value of javascript.electron.browser_windows) {
      const source = electronFindingSourceNode(context, file, value.module_key);
      if (source !== undefined)
        addBrowserWindow({ context, file, source, value, coverage });
    }
    for (const value of javascript.electron.context_bridge_apis) {
      const source = electronFindingSourceNode(context, file, value.module_key);
      if (source !== undefined)
        addContextBridge({ context, file, source, value, coverage });
    }
    for (const value of javascript.electron.utility_processes) {
      const source = electronFindingSourceNode(context, file, value.module_key);
      if (source !== undefined)
        addUtilityProcess({ context, file, source, value, coverage });
    }
  }
};

const addBrowserWindow = (
  input: FindingInput<ElectronBrowserWindowFinding>,
): void => {
  const { context, file, value, coverage } = input;
  const window = context.accumulator.addNode({
    kind: "browser-window",
    identity: artifactLocalIdentity(
      file.sha256,
      "electron-browser-window",
      electronRangeKey(value.location),
    ),
    observations: [
      {
        label: `BrowserWindow@${electronRangeKey(value.location)}`,
        properties: {
          source_path: file.path,
          options_status: value.options_status,
          web_preferences_status: value.web_preferences_status,
          web_preferences: value.web_preferences,
          omitted_web_preferences: value.omitted_web_preferences,
          preload_path: value.preload_path,
          preload_resolution_context: value.preload_resolution_context,
          absence_means_default: false,
        },
        evidence: astObservationEvidence({
          sha256: file.sha256,
          path: file.path,
          range: value.location,
          operation: "observe-browser-window-construction",
          coverage,
          limitations: [
            "Only explicitly present webPreferences are reported; omitted properties are not interpreted as Electron defaults.",
          ],
        }),
      },
    ],
  });
  addElectronAstEdge(context, {
    source: input.source,
    target: window,
    file,
    range: value.location,
    coverage,
    relation: "contains",
    operation: "locate-browser-window-construction",
    properties: { source_path: file.path },
  });
  addWindowPreload(input, window);
};

const addWindowPreload = (
  input: FindingInput<ElectronBrowserWindowFinding>,
  window: ApplicationNode,
): void => {
  const declared = input.value.preload_path;
  if (declared === null) return;
  const resolution = resolveArtifactPathByContext({
    declaredPath: declared,
    sourcePath: input.file.path,
    context: input.value.preload_resolution_context ?? "module-specifier",
    files: input.context.filesByPath,
  });
  const role = createElectronRoleNode(input.context, {
    kind: "electron-preload",
    anchor: input.file,
    resolution,
    mechanism: "BrowserWindow:webPreferences.preload",
    range: input.value.location,
    coverage: input.coverage,
  });
  addElectronInferenceEdge(input.context, {
    source: window,
    target: role,
    file: input.file,
    range: input.value.location,
    coverage: input.coverage,
    relation: "loads",
    operation: "associate-browser-window-preload",
    properties: {
      declared_path: declared,
      resolution_context: resolution.resolution_context,
      resolved_path: resolution.resolved_path,
      resolution_status: resolution.resolution_status,
      limitations: resolution.limitations,
    },
  });
  linkElectronRoleToAsset(input.context, {
    role,
    anchor: input.file,
    resolution,
    range: input.value.location,
    coverage: input.coverage,
  });
};

const addContextBridge = (
  input: FindingInput<ElectronContextBridgeFinding>,
): void => {
  const { context, file, value, coverage } = input;
  const bridge = context.accumulator.addNode({
    kind: "context-bridge-api",
    identity: artifactLocalIdentity(
      file.sha256,
      "electron-context-bridge",
      `${value.world}:${value.api_key ?? value.api_key_expression ?? "[missing]"}:${electronRangeKey(value.location)}`,
    ),
    observations: [
      {
        label: value.api_key,
        properties: {
          world: value.world,
          world_id: value.world_id,
          api_key: value.api_key,
          api_key_expression: value.api_key_expression,
          api_status: value.api_status,
          members: value.members,
          unknown_members: value.unknown_members,
          omitted_members: value.omitted_members,
        },
        evidence: astObservationEvidence({
          sha256: file.sha256,
          path: file.path,
          range: value.location,
          operation: "observe-context-bridge-api",
          coverage,
        }),
      },
    ],
  });
  addElectronInferenceEdge(context, {
    source: input.source,
    target: bridge,
    file,
    range: value.location,
    coverage,
    relation: "exposes",
    operation: "map-context-bridge-exposure",
    properties: {
      world: value.world,
      api_key: value.api_key,
      resolution: value.api_key === null ? "dynamic" : "literal",
    },
  });
};

const addUtilityProcess = (
  input: FindingInput<ElectronUtilityProcessFinding>,
): void => {
  const { context, file, value, coverage } = input;
  const utility = context.accumulator.addNode({
    kind: "electron-utility",
    identity: artifactLocalIdentity(
      file.sha256,
      "electron-utility-process",
      `${value.module_path ?? value.module_expression ?? "[missing]"}:${electronRangeKey(value.location)}`,
    ),
    observations: [
      {
        label: value.service_name ?? value.module_path,
        properties: {
          module_path: value.module_path,
          module_resolution_context: value.module_resolution_context,
          module_expression: value.module_expression,
          service_name: value.service_name,
        },
        evidence: astObservationEvidence({
          sha256: file.sha256,
          path: file.path,
          range: value.location,
          operation: "observe-utility-process-fork",
          coverage,
        }),
      },
    ],
  });
  addElectronInferenceEdge(context, {
    source: input.source,
    target: utility,
    file,
    range: value.location,
    coverage,
    relation: "loads",
    operation: "map-utility-process-launch",
    properties: {
      declared_path: value.module_path,
      expression: value.module_expression,
    },
  });
  if (value.module_path === null) return;
  const resolution = resolveArtifactPathByContext({
    declaredPath: value.module_path,
    sourcePath: file.path,
    context: value.module_resolution_context ?? "module-specifier",
    files: context.filesByPath,
  });
  const resolved = resolution.resolved_path;
  const target =
    resolved === null
      ? undefined
      : (context.assetNodes.get(resolved) ?? context.fileNodes.get(resolved));
  if (target === undefined) return;
  addElectronInferenceEdge(context, {
    source: utility,
    target,
    file,
    range: value.location,
    coverage,
    relation: "maps_to",
    operation: "resolve-utility-process-entrypoint",
    properties: {
      declared_path: value.module_path,
      resolution_context: resolution.resolution_context,
      resolved_path: resolved,
      resolution_status: resolution.resolution_status,
    },
  });
};
