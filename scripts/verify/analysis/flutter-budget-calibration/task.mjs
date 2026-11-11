import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import assert from "node:assert/strict";
const [repository, configPath] = process.argv.slice(2);
const config = JSON.parse(await readFile(configPath, "utf8"));
const { FlutterBuildAnalysisService } = await import(
  pathToFileURL(
    join(repository, "src/application/flutter/FlutterBuildAnalysisService.ts"),
  )
);
const { createFlutterBuildAnalysisProvider } = await import(
  pathToFileURL(join(repository, "src/composition/flutter.ts"))
);
const { estimateTokenCount } = await import(
  pathToFileURL(join(repository, "node_modules/tokenx/dist/index.mjs"))
);
const oracle = JSON.parse(await readFile(config.oracle, "utf8"));
const calls = [];
const provider = createFlutterBuildAnalysisProvider();
const service = new FlutterBuildAnalysisService(provider);
try {
  let uriLimit = config.first_uri_limit;
  for (let attempt = 0; attempt < 5; attempt++) {
    const input = {
      path: config.artifact,
      abi: "arm64-v8a",
      pool_policy: {
        ...(uriLimit === undefined ? {} : { uri_limit: uriLimit }),
        ...(config.task === "package-inventory"
          ? { contains: "package:" }
          : {}),
      },
    };
    const request = { operation: "inspect_dart_aot", input };
    const reply = await service.execute(request.operation, request.input);
    calls.push({
      request,
      reply,
      request_token_estimate: estimateTokenCount(JSON.stringify(request)),
      reply_token_estimate: estimateTokenCount(JSON.stringify(reply)),
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const result = reply.value.normalized_result;
    assert.equal(result.target.sha256, oracle.artifact_sha256);
    assert.equal(result.libapp.sha256, oracle.libapp_sha256);
    assert.equal(result.abi, oracle.abi);
    assert.equal(result.string_pool.policy.run_bytes, 1024);
    assert.equal(result.string_pool.policy.token_bytes, 128);
    assert.equal(result.string_pool.policy.token_limit, 2000);
    if (config.task === "package-inventory") {
      const expected = oracle.policies["1024"].package_uris;
      if (
        result.string_pool.package_uris.length <
        result.string_pool.package_uri_count_at_least
      ) {
        assert.equal(
          config.recover,
          true,
          "Candidate failed inventory completeness",
        );
        uriLimit = config.recovery_uri_limit;
        continue;
      }
      assert.deepEqual([...result.string_pool.package_uris].sort(), expected);
    } else {
      // Overview controls verify identity, ABI and snapshot section identities;
      // they deliberately do not require any printable string values.
      const section = result.libapp.sections.find(
        ({ name }) => name === oracle.section.name,
      );
      assert.ok(
        section,
        "Overview omitted the independently pinned snapshot section",
      );
      assert.deepEqual(
        { name: section.name, offset: section.offset, size: section.size },
        oracle.section,
        "Overview snapshot section identity differs from the independent ELF oracle",
      );
    }
    const tokenEstimate = calls.reduce(
      (n, call) => n + call.request_token_estimate + call.reply_token_estimate,
      0,
    );
    const receipt = {
      task: config.task,
      boundary:
        "shared application service; excludes CLI/MCP discovery, adapter delivery, retained resource overhead and model reasoning",
      token_estimator:
        "tokenx 1.3.0, estimate only; all logical requests and replies including retries",
      token_estimate: tokenEstimate,
      call_count: calls.length,
      success: true,
      pool_coverage: result.string_pool.coverage,
      package_uris_delivered_final: result.string_pool.package_uris.length,
      package_uri_count_at_least_final:
        result.string_pool.package_uri_count_at_least,
      config,
      calls,
    };
    await writeFile(
      config.reply_receipt,
      JSON.stringify(receipt, null, 2) + "\n",
    );
    process.stdout.write(
      JSON.stringify({ ...receipt, calls: undefined }) + "\n",
    );
    break;
  }
  assert.ok(calls.length < 5, "Recovery did not complete");
} finally {
  await provider.close();
}
