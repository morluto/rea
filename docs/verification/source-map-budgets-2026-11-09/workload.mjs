import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [projectRoot, configText] = process.argv.slice(2);
const config = JSON.parse(configText);
const require = createRequire(join(projectRoot, "package.json"));
assert(
  config.artifactDir,
  "Select artifactDir containing the acquired artifacts.json",
);
const manifest = JSON.parse(
  await readFile(join(config.artifactDir, "artifacts.json"), "utf8"),
).map((source) => ({ ...source, path: join(config.artifactDir, source.path) }));
const selected =
  config.select === "all"
    ? manifest
    : manifest.filter((x) => x.path.includes(config.select));
assert(selected.length > 0);
const load = (path) => import(pathToFileURL(join(projectRoot, path)).href);
const { projectAnalysisError } = await load(
  "src/domain/analysisErrorProjection.ts",
);
const calls = [];
let finalResult;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const start = performance.now();
if (config.mode === "point") {
  const { SourceMapDecoder } = await load(
    "src/javascript/sourceMaps/SourceMapDecoder.ts",
  );
  const { WebSourceLocationService } = await load(
    "src/application/WebSourceLocationService.ts",
  );
  const { LocalWebSourceLocationArtifacts } = await load(
    "src/browser/assets/WebSourceLocationArtifacts.ts",
  );
  const { spawnOwnedProviderProcess } = await load(
    "src/process/ProviderProcess.ts",
  );
  const decoder = new SourceMapDecoder({
    launcher: (options) =>
      spawnOwnedProviderProcess({
        ...options,
        arguments: [
          "--import",
          require.resolve("tsx"),
          ...options.arguments.map((x) =>
            x.endsWith("/SourceMapCodecProcess.js")
              ? join(
                  projectRoot,
                  "src/javascript/sourceMaps/SourceMapCodecProcess.ts",
                )
              : x,
          ),
        ],
      }),
  });
  const service = new WebSourceLocationService(
    new LocalWebSourceLocationArtifacts(),
    decoder,
  );
  try {
    for (const source of selected) {
      const text = await readFile(source.path, "utf8");
      const policies =
        config.strategy === "recover"
          ? [{}, config.policy]
          : [config.policy ?? {}];
      let completed = false;
      for (const policy of policies) {
        const args = {
          manifest_path: source.path.slice(0, -4) + ".manifest.json",
          script_index: 0,
          source_map: { path: source.path, url: source.url },
          generated_position: source.point,
          ...(Object.keys(policy).length ? { source_map_limits: policy } : {}),
        };
        const began = performance.now();
        const result = await service.trace(args);
        calls.push({
          operation: "trace_web_source_location",
          args,
          reply: result.ok ? result.value : projectAnalysisError(result.error),
          elapsed_ms: performance.now() - began,
        });
        if (!result.ok) continue;
        const report = result.value.normalized_result;
        assert.equal(report.source_map_sha256, source.sha256);
        assert.equal(report.matches.length, source.expected_matches.length);
        for (let i = 0; i < source.expected_matches.length; i++) {
          const expected = source.expected_matches[i],
            actual = report.matches[i];
          assert.equal(
            actual.state,
            expected.generated_only ? "generated-only" : "mapped",
          );
          if (expected.generated_only) continue;
          assert.equal(actual.source_index, expected.source_index);
          assert.equal(actual.reported_source, expected.source);
          assert.equal(actual.original_position.line, expected.original_line);
          assert.equal(
            actual.original_position.column,
            expected.original_column,
          );
          assert.equal(actual.content.state, "embedded");
          assert.equal(actual.content.utf8_sha256, expected.content_sha256);
        }
        finalResult = result.value;
        completed = true;
        break;
      }
      assert(
        completed,
        `point incomplete for ${source.path}: ${JSON.stringify(calls.at(-1)?.reply)}`,
      );
    }
  } finally {
    await service.close();
  }
} else {
  const { fetchWebSourceMaps } = await load(
    "src/browser/WebSourceMapFetcher.ts",
  );
  const { analyzeWebBundleInputSchema, webBundleAnalysisSchema } = await load(
    "src/domain/webBundleAnalysis.ts",
  );
  const { jsonValueSchema } = await load("src/domain/jsonValue.ts");
  const { createBrowserEvidence } = await load(
    "src/application/BrowserEvidence.ts",
  );
  const requests = selected.map((s, i) => ({
    scriptKey: `scr_${String(i + 1).padStart(64, "0")}`,
    declaredUrl: s.url,
    fetchUrl: s.url,
  }));
  const policies =
    config.strategy === "recover" ? [{}, config.policy] : [config.policy ?? {}];
  const byUrl = new Map(selected.map((s) => [s.url, s]));
  let completed = false;
  for (const policy of policies) {
    const input = analyzeWebBundleInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      allowed_origins: ["https://demo.actualbudget.org"],
      target_id: "calibration-artifact-replay",
      fetch_source_maps: true,
      ...(Object.keys(policy).length ? { source_map_limits: policy } : {}),
    });
    const began = performance.now();
    const result = await fetchWebSourceMaps(requests, input, undefined, {
      fetch: async (url) =>
        new Response(await readFile(byUrl.get(String(url)).path), {
          status: 200,
          headers: { "content-type": "application/source-map+json" },
        }),
    });
    let reply = result.ok ? result.value : projectAnalysisError(result.error);
    if (result.ok && config.evidence !== false) {
      // Isolate source-map retention cost: script capture/analysis are explicitly outside this replay.
      const bundle = webBundleAnalysisSchema.parse({
        capture: {
          target_url: "https://demo.actualbudget.org/",
          target_origin: "https://demo.actualbudget.org",
          scripts_observed: 0,
          scripts_analyzed: 0,
          source_artifacts: [],
        },
        observations: {
          chunks: { nodes: [], edges: [] },
          routes: [],
          endpoints: [],
          webmcp_declarations: [],
          source_maps: result.value,
        },
        inferences: [],
        unknowns: [],
        completeness: {
          status: result.value.status === "included" ? "complete" : "partial",
          parsed_scripts: 0,
          parse_failures: 0,
          visited_ast_nodes: 0,
        },
        limitations: [
          "Pinned public source-map transport replay. Browser capture and generated-script static analysis were not performed.",
        ],
      });
      jsonValueSchema.parse(bundle);
      const evidence = createBrowserEvidence(
        "analyze_web_bundle",
        input,
        bundle,
        {
          id: "source-map-calibration-replay",
          name: "Pinned public source-map replay",
          version: "1",
        },
      );
      // Include actual Evidence envelope cost rather than only the producer report.
      reply = evidence;
    }
    calls.push({
      operation: "analyze_web_bundle.source_maps",
      args: {
        source_urls: selected.map((s) => s.url),
        source_sha256s: selected.map((s) => s.sha256),
        ...(Object.keys(policy).length ? { source_map_limits: policy } : {}),
      },
      reply,
      elapsed_ms: performance.now() - began,
    });
    if (
      !result.ok ||
      result.value.items.length !== selected.length ||
      result.value.items.some(
        (item) => !["included", "partial"].includes(item.status),
      )
    )
      continue;
    for (let i = 0; i < selected.length; i++) {
      const original = selected[i],
        item = result.value.items[i],
        raw = JSON.parse(await readFile(original.path, "utf8"));
      assert(["included", "partial"].includes(item.status));
      assert.equal(item.mappings.length, original.mapped_count);
      assert.equal(item.artifact.sha256, original.sha256);
      assert.equal(item.original_sources.length, raw.sources.length);
      const expected = original.expected_matches.filter(
        (x) => !x.generated_only,
      );
      const actual = item.mappings.filter(
        (x) =>
          x.generated_line === original.point.line &&
          x.generated_column === original.point.column,
      );
      assert.equal(actual.length, expected.length);
      for (let j = 0; j < expected.length; j++) {
        assert.equal(actual[j].source_index, expected[j].source_index);
        assert.equal(actual[j].original_line, expected[j].original_line);
        assert.equal(actual[j].original_column, expected[j].original_column);
      }
      for (let j = 0; j < raw.sources.length; j++) {
        assert.equal(item.original_sources[j].source_index, j);
        if (raw.sourcesContent[j] !== null)
          assert.equal(
            item.original_sources[j].artifact.sha256,
            digest(raw.sourcesContent[j]),
          );
      }
    }
    finalResult = result.value;
    completed = true;
    break;
  }
  if (!completed && config.allowIncomplete !== true)
    throw Error(
      `fetch incomplete: ${JSON.stringify(calls.at(-1)?.reply?.items?.map((i) => ({ status: i.status, limitation: i.limitation })))}`,
    );
}
if (config.resultPath)
  await writeFile(config.resultPath, JSON.stringify({ config, calls }));
const rows = calls.map((c) => {
  const report =
    c.reply.normalized_result?.observations?.source_maps ?? c.reply;
  return {
    operation: c.operation,
    elapsed_ms: c.elapsed_ms,
    reply_bytes: Buffer.byteLength(JSON.stringify(c.reply)),
    state: report.status ?? (c.reply.code ? "error" : "complete"),
    error: c.reply.code ? c.reply.message : undefined,
    items: report.items?.map((i) => ({
      status: i.status,
      sources: i.original_sources?.length,
      mappings: i.mappings?.length,
      limitation: i.limitation,
    })),
  };
});
console.log(
  JSON.stringify({
    config,
    operation_ms: performance.now() - start,
    calls: rows,
    result_sha256: finalResult ? digest(JSON.stringify(finalResult)) : null,
    resource_usage: process.resourceUsage(),
  }),
);
