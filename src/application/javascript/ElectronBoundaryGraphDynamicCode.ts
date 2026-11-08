import { javascriptSourceRangeKey } from "../../domain/javascript/javascriptSourceCoordinates.js";
import type {
  ElectronDynamicCodeFinding,
  ElectronDynamicCodeSource,
} from "../../domain/javascript/electronStaticAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import {
  javascriptAnalysisCoverage,
  type JavaScriptArtifactGraphContext,
  type JavaScriptArtifactGraphCoverage,
} from "./JavaScriptArtifactGraphContext.js";
import { astObservationEvidence } from "./JavaScriptArtifactGraphEvidence.js";
import { compositeKey } from "../../domain/unicodeCodePointOrder.js";
import {
  addElectronAstEdge,
  addElectronInferenceEdge,
  electronFindingSourceNode,
  electronObservationIdentity,
} from "./ElectronBoundaryGraphContext.js";
import { resolveArtifactPathByContext } from "./JavaScriptArtifactPathResolution.js";

interface DynamicCodeInput {
  readonly context: JavaScriptArtifactGraphContext;
  readonly file: JavaScriptArtifactFile;
  readonly value: ElectronDynamicCodeFinding;
  readonly coverage: JavaScriptArtifactGraphCoverage;
}

const BYTECODE_EXECUTION_LIMITATION =
  "V8 compiled this code from opaque cachedData bytecode. Declarations, contextBridge APIs, IPC calls and other logic inside that snapshot are not in the analyzed source and are not reported as absent.";

/**
 * Project `node:vm` compilations. A `cachedData` handoff becomes an explicit
 * unknown carrying the inventoried cache artifact, so a thin wrapper whose
 * preload logic lives in a bytecode cache is not read as an empty preload.
 */
export const addElectronDynamicCodeBoundaries = (
  context: JavaScriptArtifactGraphContext,
): void => {
  for (const analyzed of context.analysis.files) {
    const { file, javascript } = analyzed;
    if (javascript === null) continue;
    const coverage = javascriptAnalysisCoverage(javascript);
    for (const value of javascript.electron.dynamic_code ?? [])
      addDynamicCodeSite({ context, file, value, coverage });
  }
};

const addDynamicCodeSite = (input: DynamicCodeInput): void => {
  const { context, file, value, coverage } = input;
  if (value.execution !== "cached-data") return;
  const source = electronFindingSourceNode(
    context,
    file,
    value.module_key,
    value.module_runtime,
  );
  if (source === undefined) return;
  const cache = value.cached_data;
  const resolved = resolveCache(context, file, cache);
  const node = context.accumulator.addNode({
    kind: "unknown",
    identity: electronObservationIdentity(
      context,
      "javascript-v8-cached-data",
      compositeKey([
        file.path,
        value.api,
        cache.source_path,
        cache.source_expression,
        javascriptSourceRangeKey(value.location),
      ]),
    ),
    observations: [
      {
        label: cache.source_path ?? cache.source_expression,
        properties: {
          api: value.api,
          execution: value.execution,
          cache_path: cache.source_path,
          cache_expression: cache.source_expression,
          resolved_cache_path: resolved,
          source_text: value.source_text.value,
          source_expression: value.source_text.expression,
          execution_boundary: "v8-cached-data",
        },
        evidence: astObservationEvidence({
          sha256: file.sha256,
          path: file.path,
          range: value.location,
          operation: "observe-v8-cached-data-execution",
          coverage,
          limitations: [BYTECODE_EXECUTION_LIMITATION],
        }),
      },
    ],
  });
  addElectronAstEdge(context, {
    source,
    target: node,
    file,
    range: value.location,
    coverage,
    relation: "loads",
    operation: "execute-v8-cached-data",
    properties: {
      api: value.api,
      cache_path: cache.source_path,
      cache_expression: cache.source_expression,
      resolved_cache_path: resolved,
    },
    limitations: [BYTECODE_EXECUTION_LIMITATION],
  });
};

/**
 * The cache artifact the handoff names, when the path is inert syntax. The
 * cache often is not a file this analysis reads, so lookup uses the full
 * inventory map rather than the relevant-file projection.
 */
const resolveCache = (
  context: JavaScriptArtifactGraphContext,
  file: JavaScriptArtifactFile,
  cache: ElectronDynamicCodeSource,
): string | null => {
  if (cache.source_path === null) return null;
  const resolved = resolveArtifactPathByContext({
    declaredPath: cache.source_path,
    sourcePath: file.path,
    context: cache.source_resolution_context,
    files: context.filesByPath,
    jsonDocuments: context.analysis.jsonDocuments,
    directoryPaths: context.directoryPaths,
    moduleKind: "require",
  }).resolved_path;
  return resolved ?? cache.source_path;
};
