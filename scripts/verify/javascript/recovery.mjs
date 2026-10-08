#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseEvidence } from "../../../dist/domain/evidence.js";
import { javascriptRecoveryResultSchema } from "../../../dist/domain/javascript/javascriptRecovery.js";
import { buildRecoveryFixtures } from "../../fixtures/javascript-recovery/build.mjs";
import { mcpTextValue } from "../../lib/mcp-verifier-results.mjs";

const OFFICIAL_BINARY_SHA256 =
  "e8c7ca052974604197389f6ace7464e4dd24dce64e2730971521bd6606ec9c9e";
if (!process.env.REA_WAKARU_COMMAND)
  throw new Error(
    "Provide REA_WAKARU_COMMAND for the official Wakaru 1.13.0 Linux x64 binary",
  );
const entrypoint =
  process.argv[2] ?? fileURLToPath(new URL("../../rea.mjs", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "rea-real-recovery-"));
const environment = { ...process.env, REA_LOG_LEVEL: "silent" };
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env: environment,
  stderr: "pipe",
});
const client = new Client({ name: "real-recovery", version: "1" });
const run = promisify(execFile);
const cli = async (...args) => {
  const { stdout } = await run(
    process.execPath,
    [entrypoint, ...args, "--json"],
    { env: environment, timeout: 150000, maxBuffer: 32 * 1024 * 1024 },
  );
  return parseEvidence(JSON.parse(stdout));
};
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 150000,
  });
  assert.notEqual(result.isError, true, mcpTextValue(result));
  return parseEvidence(JSON.parse(mcpTextValue(result)).evidence);
};
const fingerprint = (bytes) => createHash("sha256").update(bytes).digest("hex");
const counts = [];
let finalReport;
try {
  const fixtures = await buildRecoveryFixtures(
    root,
    process.env.REA_JAVASCRIPT_FIXTURE_TOOLS,
  );
  await client.connect(transport);
  for (const fixture of fixtures.files) {
    for (const surface of ["cli", "stdio_mcp"]) {
      const output = join(root, `${fixture.name}-${surface}`);
      const flags =
        fixture.options === undefined
          ? []
          : [
              "--extraction-mode",
              fixture.options.extraction_mode,
              "--rewrite-level",
              fixture.options.rewrite_level,
            ];
      const evidence =
        surface === "cli"
          ? await cli(
              "recover-javascript-sources",
              fixture.path,
              output,
              ...flags,
            )
          : await call("recover_javascript_sources", {
              path: fixture.path,
              output_directory: output,
              ...fixture.options,
            });
      const result = javascriptRecoveryResultSchema.parse(
        evidence.normalized_result,
      );
      await assertRecoveredArtifacts(evidence, result, fixture);
      const analysis =
        surface === "cli"
          ? await cli(
              "analyze-javascript-application",
              result.analysis_input.input_path,
            )
          : await call("analyze_javascript_application", result.analysis_input);
      assert.equal(analysis.normalized_result.statistics.parse_failures, 0);
      assert.equal(
        analysis.normalized_result.statistics.parsed_javascript_files,
        result.modules.length,
      );
      const recoveredEntry =
        result.modules.find(
          (module) => module.reported_filename === "entry.js",
        ) ?? result.modules[0];
      assert.ok(recoveredEntry);
      const oracle =
        'await import((await import("node:url")).pathToFileURL(process.argv[1])); const f=globalThis.recoveryFixture; console.log(JSON.stringify([f.greet(null),f.greet("REA"),f.total([1,2,3])]));';
      for (const selected of fixture.options?.extraction_mode === "inspection"
        ? []
        : [fixture.path, recoveredEntry.artifact.path]) {
        const execution = await run(
          process.execPath,
          ["--input-type=module", "-e", oracle, selected],
          { env: environment, timeout: 10000 },
        );
        assert.deepEqual(JSON.parse(execution.stdout), [
          "Hello world",
          "Hello REA",
          6,
        ]);
      }
      counts.push({
        fixture: fixture.name,
        surface,
        modules: result.modules.length,
        maps: result.modules.filter((module) => module.source_map !== null)
          .length,
        finite_fixture_oracle:
          fixture.options?.extraction_mode !== "inspection",
      });
    }
  }
  finalReport = {
    engine: "wakaru 1.13.0",
    toolchains: fixtures.toolchains,
    results: counts,
    verified: true,
  };
} finally {
  await client.close();
  await transport.close();
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(finalReport));

async function assertRecoveredArtifacts(evidence, result, fixture) {
  assert.deepEqual(result.options, {
    extraction_mode: "structural",
    rewrite_level: "standard",
    ...fixture.options,
  });
  if (fixture.options?.extraction_mode === "inspection")
    assert.equal(result.reported_safety, "inspection-only");
  assert.equal(result.engine.executable.sha256, OFFICIAL_BINARY_SHA256);
  assert.equal(result.engine.executed_source_revision, null);
  assert.equal(evidence.confidence, "derived");
  assert.equal(result.runtime_equivalence, "unknown");
  assert.equal(result.status, "complete");
  assert.equal(result.reported_format, fixture.expectedFormat);
  assert.equal(result.modules.length, fixture.expectedModules);
  assert.equal(result.source.sha256, fingerprint(await readFile(fixture.path)));
  for (const file of [
    result.source.published_copy,
    result.report,
    result.provenance,
    result.manifest,
    ...result.modules.flatMap((module) => [
      module.artifact,
      ...(module.source_map ? [module.source_map] : []),
    ]),
  ]) {
    const bytes = await readFile(file.path);
    assert.equal(bytes.length, file.bytes);
    assert.equal(fingerprint(bytes), file.sha256);
  }
  for (const module of result.modules) {
    assert.equal(module.provenance.original_sha256, result.source.sha256);
    assert.equal(module.provenance.reported_input, result.source.snapshot_path);
    for (const range of module.provenance.byte_ranges)
      assert.ok(range.start <= range.end && range.end <= result.source.bytes);
    if (module.source_map) {
      const map = JSON.parse(await readFile(module.source_map.path, "utf8"));
      for (const source of map.sources)
        assert.equal(
          resolve(dirname(module.source_map.path), source),
          result.source.published_copy.path,
        );
    }
  }
}
