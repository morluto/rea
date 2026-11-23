import { isPossibleCachedDataCompilation } from "../../domain/javascript/electronDynamicCodeFacts.js";
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

const CACHED_DATA_COMPILATION_LIMITATION =
  "Source syntax declares or may supply cachedData to a V8 compilation API. Static analysis does not establish valid cache bytes, V8 acceptance, or execution; logic inside a possible cache remains unknown.";

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
  if (!isPossibleCachedDataCompilation(value)) return;
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
          cached_data_status: value.cached_data_status,
          cache_path: cache.source_path,
          cache_expression: cache.source_expression,
          cache_path_base:
            cache.source_path === null
              ? null
              : (cache.source_path_base ?? null),
          resolved_cache_path: resolved?.resolved_path ?? null,
          resolution_status: resolved?.resolution_status ?? null,
          resolution_context: resolved?.resolution_context ?? null,
          candidate_cache_path: resolved?.candidate_path ?? null,
          resolution_limitations: resolved?.limitations ?? [],
          source_text: value.source_text.value,
          source_expression: value.source_text.expression,
          compilation_boundary: "v8-cached-data",
        },
        evidence: astObservationEvidence({
          sha256: file.sha256,
          path: file.path,
          range: value.location,
          operation: "observe-v8-cached-data-compilation",
          coverage,
          limitations: [CACHED_DATA_COMPILATION_LIMITATION],
        }),
      },
    ],
  });
  addElectronInferenceEdge(context, {
    source,
    target: node,
    file,
    range: value.location,
    coverage,
    relation: "loads",
    operation: "associate-v8-cached-data-compilation",
    properties: {
      api: value.api,
      cache_path: cache.source_path,
      cache_expression: cache.source_expression,
      cache_path_base:
        cache.source_path === null ? null : (cache.source_path_base ?? null),
      resolved_cache_path: resolved?.resolved_path ?? null,
      resolution_status: resolved?.resolution_status ?? null,
      resolution_context: resolved?.resolution_context ?? null,
      candidate_cache_path: resolved?.candidate_path ?? null,
      resolution_limitations: resolved?.limitations ?? [],
    },
    limitations: [CACHED_DATA_COMPILATION_LIMITATION],
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
) => {
  if (
    cache.source_path === null ||
    cache.source_path_base !== "source-directory"
  )
    return null;
  const resolved = resolveArtifactPathByContext({
    declaredPath: cache.source_path,
    sourcePath: file.path,
    context: cache.source_resolution_context,
    files: context.filesByPath,
    jsonDocuments: context.analysis.jsonDocuments,
    directoryPaths: context.directoryPaths,
    unanalyzedFiles: context.unanalyzedFiles,
    runtimePathKind: "exact-file",
  });
  return resolved;
};
