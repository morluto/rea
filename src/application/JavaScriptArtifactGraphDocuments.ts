import {
  addArtifactContainsEdge,
  addStaticInferenceEdge,
  createElectronRoleNode,
  resolveArtifactPath,
  type JavaScriptArtifactGraphContext,
} from "./JavaScriptArtifactGraphContext.js";
import {
  artifactObservationEvidence,
  completeReconstructionCoverage,
  partialReconstructionCoverage,
} from "./JavaScriptArtifactGraphEvidence.js";

/** Project HTML renderer entrypoints and their local script assets. */
export const addJavaScriptHtmlRoles = (
  context: JavaScriptArtifactGraphContext,
): void => {
  const byHtml = new Map<string, typeof context.analysis.html_scripts>();
  for (const script of context.analysis.html_scripts) {
    const existing = byHtml.get(script.html_path);
    byHtml.set(
      script.html_path,
      existing === undefined ? [script] : [...existing, script],
    );
  }
  for (const [htmlPath, scripts] of byHtml) {
    const html = context.filesByPath.get(htmlPath);
    if (html === undefined) continue;
    const role = createElectronRoleNode(context, {
      kind: "electron-renderer",
      anchor: html,
      declaredPath: html.path,
      resolvedPath: html.path,
      mechanism: "html-script-entrypoint",
    });
    addArtifactContainsEdge(context, {
      source: context.root,
      target: role,
      file: html,
      operation: "discover-html-renderer",
    });
    for (const script of scripts) {
      const resolvedPath = resolveArtifactPath(
        script.script_path,
        html.path,
        context.filesByPath,
      );
      if (resolvedPath === null) continue;
      const resolved = context.fileNodes.get(resolvedPath);
      if (resolved === undefined) continue;
      addStaticInferenceEdge(context, {
        source: role,
        target: resolved,
        file: html,
        range: script.location,
        coverage: completeReconstructionCoverage(),
        relation: "loads",
        properties: {
          script_path: script.script_path,
          resolved_path: resolvedPath,
        },
      });
    }
  }
};

/** Project original source names and optional content digests from approved maps. */
export const addJavaScriptSourceMapOriginals = (
  context: JavaScriptArtifactGraphContext,
): void => {
  for (const sourceMap of context.analysis.source_maps) {
    const mapFile = context.filesByPath.get(sourceMap.path);
    const mapNode = context.fileNodes.get(sourceMap.path);
    if (mapFile === undefined || mapNode === undefined) continue;
    const coverage =
      sourceMap.status === "truncated"
        ? partialReconstructionCoverage(
            [
              {
                name: "max-source-map-sources",
                value: context.input.limits.max_source_map_sources,
                unit: "items",
              },
            ],
            sourceMap.omitted_sources,
            true,
          )
        : completeReconstructionCoverage();
    for (const original of sourceMap.sources) {
      const node = context.accumulator.addNode({
        kind: "source-module",
        identity: {
          strategy: "source-map-original",
          stability: "source-map-exact",
          source_map_sha256: mapFile.sha256,
          original_source: original.source,
          source_sha256: original.content_sha256,
        },
        observations: [
          {
            label: original.source,
            properties: {
              source: original.source,
              content_available: original.content !== null,
              source_sha256: original.content_sha256,
            },
            evidence: artifactObservationEvidence({
              sha256: mapFile.sha256,
              path: mapFile.path,
              operation: "parse-local-source-map",
              coverage,
              limitations:
                sourceMap.limitation === null ? [] : [sourceMap.limitation],
            }),
          },
        ],
      });
      context.accumulator.addEdge({
        source_node_id: mapNode.node_id,
        target_node_id: node.node_id,
        relation: "contains",
        properties: { original_source: original.source },
        evidence: artifactObservationEvidence({
          sha256: mapFile.sha256,
          path: mapFile.path,
          operation: "parse-local-source-map",
          coverage,
          limitations:
            sourceMap.limitation === null ? [] : [sourceMap.limitation],
        }),
      });
    }
  }
};
