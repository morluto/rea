import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { createVerifierCommands } from "../../scripts/lib/verify-commands.mjs";
import { withVerifierCleanup } from "../../scripts/lib/verifier-cleanup.mjs";
// Public CLI capture and same-session retained MCP queries. All assets and output
// paths are explicitly supplied; this verifier installs no browser or application.
const { values } = parseArgs({
  options: {
    repository: { type: "string" },
    mode: { type: "string" },
    output: { type: "string" },
    parent: { type: "string" },
    application: { type: "string" },
    browser: { type: "string" },
    task: { type: "string", default: "all" },
    "verify-cli": { type: "boolean", default: false },
  },
});
assert.ok(values.repository && values.mode && values.output);
const repo = resolve(values.repository),
  mode = values.mode,
  out = resolve(values.output),
  bundle = values.parent && resolve(values.parent);
assert.ok(["capture", "complete", "selected"].includes(mode));
assert.ok(["all", "first-candidate"].includes(values.task));
assert.ok(mode === "capture" ? values.application && values.browser : bundle);
await mkdir(out);
const require = createRequire(join(repo, "package.json"));
const { Client } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client"))
);
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client/stdio"))
);
const env = {
  PATH: process.env.PATH,
  NODE_OPTIONS: "--max-old-space-size=3072",
  UV_THREADPOOL_SIZE: "2",
  REA_LOG_LEVEL: "silent",
  REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
  REA_MCP_TOOL_FAMILIES: "application,session",
};
const commands =
  mode === "capture" || values["verify-cli"]
    ? await createVerifierCommands()
    : undefined;
if (mode === "capture") {
  const { chromium } = require("playwright-core");
  const assets = resolve(values.application);
  const allowed = new Set(
    await (await import("node:fs/promises")).readdir(assets),
  );
  const server = createServer(async (req, res) => {
    try {
      const name =
        new URL(req.url, "http://127.0.0.1").pathname.slice(1) || "index.html";
      assert.ok(allowed.has(name));
      const data = await readFile(join(assets, name));
      res.setHeader(
        "Content-Type",
        name.endsWith(".js")
          ? "text/javascript"
          : name.endsWith(".css")
            ? "text/css"
            : name.endsWith(".json")
              ? "application/json"
              : "text/html",
      );
      res.setHeader(
        "Content-Type",
        res.getHeader("Content-Type") + "; charset=utf-8",
      );
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const userData = await mkdtemp(join(tmpdir(), "rea-6198-chrome-"));
  let context;
  await withVerifierCleanup(async () => {
    context = await chromium.launchPersistentContext(userData, {
      executablePath: resolve(values.browser),
      headless: true,
      args: ["--remote-debugging-port=0", "--no-sandbox"],
    });
    context
      .pages()[0]
      .on("pageerror", (e) => console.error("PAGE ERROR", e.message));
    context
      .pages()[0]
      .on("response", (r) => console.error("RESPONSE", r.status(), r.url()));
    await context.pages()[0].goto(origin, { waitUntil: "networkidle" });
    const port = (
      await readFile(join(userData, "DevToolsActivePort"), "utf8")
    ).split("\n")[0];
    const endpoint = `http://127.0.0.1:${port}`;
    const targets = await (await fetch(`${endpoint}/json/list`)).json();
    const target = targets.find(
      (t) => t.type === "page" && t.url === origin + "/",
    );
    assert.ok(target);
    const started = performance.now();
    const { stdout, stderr } = await commands.exec(
      process.execPath,
      [
        join(repo, "scripts/rea.mjs"),
        "analyze-web-bundle",
        endpoint,
        target.id,
        "--observation-ms",
        "1000",
        "--max-heap-mb",
        "1024",
        "--analysis-timeout-ms",
        "60000",
        "--total-analysis-timeout-ms",
        "90000",
        "--detail",
        "summary",
        "--evidence_output",
        join(out, "complete-evidence.json"),
        "--view",
        JSON.stringify({
          kind: "web-bundle",
          collection: "inferences",
          limit: 1,
        }),
        "--format",
        "json",
      ],
      { cwd: repo, env, maxBuffer: 64 * 1024 ** 2, timeout: 120000 },
    );
    await writeFile(join(out, "stderr.txt"), stderr);
    const delivery = JSON.parse(stdout);
    const view = delivery.summary.normalized_result;
    const complete = JSON.parse(
      await readFile(join(out, "complete-evidence.json"), "utf8"),
    );
    const evidence = complete.records.find(
      (row) => row.evidence_id === view.parent_evidence_id,
    );
    assert.ok(evidence);
    assert.equal(evidence.operation, "analyze_web_bundle");
    assert.ok(evidence.normalized_result.observations);
    assert.deepEqual(
      view.items,
      evidence.normalized_result.inferences
        .slice(0, 1)
        .map((row, source_index) => ({ source_index, ...row })),
    );
    assert.deepEqual(view.source_unknowns, evidence.normalized_result.unknowns);
    await writeFile(join(out, "delivery.json"), stdout);
    await writeFile(join(out, "parent.json"), JSON.stringify(evidence));
    // Public export/import format comes from the CLI's complete Evidence publication.
    console.log(
      JSON.stringify({
        capture_ms: performance.now() - started,
        evidence_id: evidence.evidence_id,
        counts: {
          endpoints: evidence.normalized_result.observations.endpoints.length,
          inferences: evidence.normalized_result.inferences.length,
        },
        completeness: evidence.normalized_result.completeness,
      }),
    );
  }, [
    () => commands.close(),
    async () => {
      await context?.close();
      await rm(userData, { recursive: true, force: true });
    },
    () =>
      new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      ),
  ]);
  process.exit(0);
}
const parent = JSON.parse(await readFile(bundle, "utf8"));
const report = parent.normalized_result;
const { createEvidenceBundle } = await import(
  pathToFileURL(join(repo, "dist/domain/evidenceBundle.js"))
);
const bundleFile = join(out, "input-bundle.json");
await writeFile(bundleFile, JSON.stringify(createEvidenceBundle([parent])));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repo, "scripts/rea.mjs"), "mcp"],
  cwd: repo,
  env,
  stderr: "pipe",
});
transport.stderr?.resume();
const client = new Client({
  name: "rea-web-bundle-paging-verifier",
  version: "1",
});
const calls = [];
let catalog;
async function invoke(name, args) {
  const toolDefinition = catalog.tools.find((t) => t.name === name);
  assert.ok(toolDefinition);
  const start = performance.now();
  const result = await client.callTool(
    { name, arguments: args },
    { toolDefinition, timeout: 90000 },
  );
  calls.push({
    name,
    arguments: args,
    result,
    elapsed_ms: performance.now() - start,
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent;
}
await withVerifierCleanup(async () => {
  await client.connect(transport);
  catalog = await client.listTools();
  await writeFile(join(out, "catalog.json"), JSON.stringify(catalog));
  const runs = [];
  for (const temperature of ["cold", "warm"]) {
    const start = performance.now();
    const callStart = calls.length;
    if (temperature === "cold")
      await invoke("import_evidence_bundle", { path: bundleFile });
    if (mode === "complete") {
      const full = await invoke("get_evidence_bundle", {});
      const actual = full.result.records.find(
        (r) => r.evidence_id === parent.evidence_id,
      );
      assert.deepEqual(actual, parent);
      runs.push({
        temperature,
        elapsed_ms: performance.now() - start,
        calls: calls.length - callStart,
      });
      continue;
    }
    const source = {
      kind: "retained-evidence",
      evidence_id: parent.evidence_id,
    };
    if (values.task === "all") {
      const summary = await invoke("inspect_analysis_view", {
        source,
        view: { kind: "web-bundle", collection: "summary" },
      });
      assert.equal(
        summary.normalized_result.summary.counts.endpoints,
        report.observations.endpoints.length,
      );
    }
    if (values.task === "first-candidate") {
      const value = await invoke("inspect_analysis_view", {
        source,
        view: {
          kind: "web-bundle",
          collection: "inferences",
          kinds: ["endpoint_candidate"],
          limit: 1,
        },
      });
      const index = report.inferences.findIndex(
        (row) => row.kind === "endpoint_candidate",
      );
      assert.equal(
        value.normalized_result.coverage.total,
        report.inferences.filter((row) => row.kind === "endpoint_candidate")
          .length,
      );
      assert.deepEqual(
        value.normalized_result.items,
        index < 0 ? [] : [{ source_index: index, ...report.inferences[index] }],
      );
      assert.deepEqual(
        value.normalized_result.source_unknowns,
        report.unknowns,
      );
    } else
      for (const collection of ["endpoints", "inferences"]) {
        const expected =
          collection === "endpoints"
            ? report.observations.endpoints
            : report.inferences;
        const rows = [];
        let offset = 0;
        do {
          const value = await invoke("inspect_analysis_view", {
            source,
            view: { kind: "web-bundle", collection, offset, limit: 32 },
          });
          const page = value.normalized_result;
          assert.deepEqual(page.source_unknowns, report.unknowns);
          assert.deepEqual(page.completeness, report.completeness);
          assert.equal(page.coverage.total, expected.length);
          for (const row of page.items) {
            assert.deepEqual(row, {
              source_index: rows.length,
              ...expected[rows.length],
            });
            rows.push(row);
          }
          if (page.coverage.exhausted) break;
          assert.ok(page.coverage.next_offset > offset);
          offset = page.coverage.next_offset;
        } while (true);
        assert.equal(rows.length, expected.length);
      }
    runs.push({
      temperature,
      elapsed_ms: performance.now() - start,
      calls: calls.length - callStart,
    });
  }
  if (mode === "selected" && values["verify-cli"]) {
    for (const collection of ["endpoints", "inferences"]) {
      const input = JSON.stringify({
        source: { kind: "evidence-file", path: bundle },
        view: {
          kind: "web-bundle",
          collection,
          limit: 32,
        },
      });
      const { stdout } = await commands.exec(
        process.execPath,
        [
          join(repo, "scripts/rea.mjs"),
          "inspect-analysis-view",
          input,
          "--format",
          "json",
        ],
        { cwd: repo, env, maxBuffer: 64 * 1024 ** 2, timeout: 90000 },
      );
      const cli = JSON.parse(stdout);
      assert.deepEqual(
        cli.normalized_result.items,
        (collection === "endpoints"
          ? report.observations.endpoints
          : report.inferences
        )
          .slice(0, 32)
          .map((r, source_index) => ({
            source_index,
            ...r,
          })),
      );
      assert.deepEqual(cli.normalized_result.source_unknowns, report.unknowns);
      await writeFile(join(out, `cli-${collection}.json`), stdout);
    }
  }
  await writeFile(join(out, "calls.json"), JSON.stringify(calls));
  await writeFile(
    join(out, "metrics.json"),
    JSON.stringify(
      {
        mode,
        task: values.task,
        runs,
        counts: {
          endpoints: report.observations.endpoints.length,
          inferences: report.inferences.length,
        },
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ mode, task: values.task, runs }));
}, [() => commands?.close(), () => client.close()]);
