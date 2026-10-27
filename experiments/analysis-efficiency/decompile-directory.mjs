/** Real-provider directory export, cross-session resume and retained provenance. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { finalizeRetainedQueryReceipt } from "./retained-query-finalization.mjs";

const { values } = parseArgs({
  options: Object.fromEntries(
    [
      "runtime",
      "output",
      "target",
      "project",
      "program",
      "ghidra",
      "java",
      "control",
      "heap",
      "chunk",
      "decompile-seconds",
      "history",
      "golden",
    ].map((key) => [key, { type: "string" }]),
  ),
});
for (const key of [
  "runtime",
  "output",
  "target",
  "project",
  "ghidra",
  "java",
]) {
  assert.ok(values[key], `${key} is required`);
  values[key] = resolve(values[key]);
}
const chunk = Number(values.chunk ?? 32);
assert.ok(Number.isSafeInteger(chunk) && chunk > 0);
await mkdir(values.output);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  calls: [],
  runtime: values.runtime,
  target: values.target,
  project: values.project,
};
let client, transport, account, serverLog, serverLogFinished;
// This workflow has a fixed number of public calls; pseudocode stays on disk.
const transcript = [];
let phase = "initialize";
const started = performance.now();
const tree = join(values.output, "tree");
const readIndex = async () =>
  JSON.parse(await readFile(join(tree, "decompile-index.json"), "utf8"));
const fileStates = async (index) => {
  const states = {};
  for (const row of index.functions.filter((row) => row.status === "written")) {
    const path = join(tree, row.relative_path);
    const metadata = await stat(path);
    states[row.address] = {
      sha256: digest(await readFile(path)),
      mtime_ms: metadata.mtimeMs,
    };
    assert.equal(states[row.address].sha256, row.sha256);
  }
  return states;
};
try {
  report.revision = (
    await promisify(execFile)("git", [
      "-C",
      values.runtime,
      "rev-parse",
      "HEAD",
    ])
  ).stdout.trim();
  report.target_sha256 = digest(await readFile(values.target));
  const { resolveGhidraProject } = await import(
    pathToFileURL(join(values.runtime, "dist/ghidra/GhidraProjectSnapshot.js"))
      .href
  );
  const { ArtifactResourceScope } = await import(
    pathToFileURL(
      join(values.runtime, "dist/artifacts/ArtifactResourceScope.js"),
    ).href
  );
  const fingerprint = async () => {
    const resources = new ArtifactResourceScope();
    try {
      return await resolveGhidraProject(
        {
          path: values.project,
          ...(values.program ? { programName: values.program } : {}),
        },
        { path: values.target },
        resources,
      );
    } finally {
      await resources.close();
    }
  };
  const original = await fingerprint();
  report.project_sha256 = original.sha256;
  account = await mkdtemp(join(tmpdir(), "rea-directory-investigation-"));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(values.runtime, "scripts/rea.mjs"), "mcp"],
    cwd: values.runtime,
    maxBufferSize: 10 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: account,
      USERPROFILE: account,
      JAVA_HOME: values.java,
      GHIDRA_INSTALL_DIR: values.ghidra,
      GHIDRA_HEADLESS_MAXMEM: values.heap ?? "1536M",
      JAVA_TOOL_OPTIONS: "-XX:ActiveProcessorCount=2",
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=3072",
      REA_GHIDRA_PROJECT_PATH: values.project,
      ...(values.program ? { REA_GHIDRA_PROGRAM_NAME: values.program } : {}),
      REA_GHIDRA_STARTUP_TIMEOUT_MS: "600000",
      ...(values["decompile-seconds"]
        ? { REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS: values["decompile-seconds"] }
        : {}),
      REA_MCP_TOOL_FAMILIES: "direct,enhanced,application,session",
      REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
      REA_MCP_OUTPUT_SCHEMA_PROFILE: "compact",
    },
    stderr: "pipe",
  });
  const start = transport.start.bind(transport);
  transport.start = async () => {
    const receive = transport.onmessage;
    transport.onmessage = (message) => {
      transcript.push({ phase, direction: "response", message });
      receive?.(message);
    };
    await start();
  };
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    transcript.push({ phase, direction: "request", message });
    await send(message);
  };
  serverLog = createWriteStream(join(values.output, "server.log"));
  serverLogFinished = finished(serverLog);
  serverLogFinished.catch(() => {});
  transport.stderr.pipe(serverLog);
  client = new Client({ name: "rea-directory-investigation", version: "1" });
  await client.connect(transport);
  phase = "discovery";
  const catalog = await client.listTools({}, { timeout: 15000 });
  await writeFile(join(values.output, "catalog.json"), JSON.stringify(catalog));
  report.tools = catalog.tools.length;
  const definitions = new Map(catalog.tools.map((tool) => [tool.name, tool]));
  const call = async (name, args, label) => {
    phase = label;
    const at = performance.now();
    const result = await client.callTool(
      { name, arguments: args },
      { timeout: 900000, toolDefinition: definitions.get(name) },
    );
    report.calls.push({
      name,
      phase,
      elapsed_ms: performance.now() - at,
      response_bytes: Buffer.byteLength(JSON.stringify(result)),
      is_error: result.isError ?? false,
    });
    assert.notEqual(
      result.isError,
      true,
      `${name}: ${JSON.stringify(result).slice(0, 800)}`,
    );
    return result.structuredContent;
  };
  const open = () =>
    call("open_binary", { path: values.target, provider_id: "ghidra" }, "open");
  await open();
  const first = await call(
    "decompile_all",
    { output_directory: tree, limit: chunk },
    "first-chunk",
  );
  report.first = first.normalized_result;
  const firstFiles = await fileStates(await readIndex());
  await call("close_binary", {}, "close-first-session");
  await open();
  const remaining = await call(
    "decompile_all",
    { output_directory: tree, resume: true },
    "cross-session-resume",
  );
  report.resume = remaining.normalized_result;
  report.resume_evidence_links = remaining.evidence_links?.length ?? 0;
  let index = await readIndex();
  const allFiles = await fileStates(index);
  for (const [address, state] of Object.entries(firstFiles))
    assert.deepEqual(allFiles[address], state);
  report.first_files_unchanged = true;
  const settled = await call(
    "decompile_all",
    { output_directory: tree, resume: true },
    "verified-resume",
  );
  report.verified_resume = settled.normalized_result;
  if (report.resume.counts.failed === 0)
    assert.equal(report.verified_resume.counts.written, 0);
  assert.equal(report.verified_resume.counts.remaining, 0);
  index = await readIndex();
  const settledFiles = await fileStates(index);
  for (const [address, state] of Object.entries(allFiles))
    assert.deepEqual(settledFiles[address], state);
  assert.equal(index.functions.length, report.resume.counts.selected);
  const facts = [];
  for (const row of index.functions) {
    const fact = {
      address: row.address,
      name: row.name,
      status: row.status,
      body: row.body,
    };
    if (row.status === "written") {
      const text = await readFile(join(tree, row.relative_path), "utf8");
      assert.ok(text.includes(`// address: ${row.address}\n`));
      assert.ok(
        text.includes(
          `// analysis_profile: ${index.analysis_profile_digest}\n`,
        ),
      );
      fact.pseudocode_sha256 = digest(text.slice(text.indexOf("\n\n") + 2));
    }
    facts.push(fact);
  }
  report.function_count = facts.length;
  report.written = facts.filter((row) => row.status === "written").length;
  report.failed = facts.filter((row) => row.status === "failed").length;
  report.external = facts.filter((row) => row.status === "external").length;
  report.facts_sha256 = digest(JSON.stringify(facts));
  await writeFile(join(values.output, "facts.json"), JSON.stringify(facts));
  const evidencePath = join(values.output, "complete-evidence.json");
  await call(
    "export_evidence_bundle",
    { path: evidencePath },
    "complete-evidence-export",
  );
  await call("close_binary", {}, "close");
  await client.close();
  await transport.close();
  const { parseEvidenceBundle } = await import(
    pathToFileURL(join(values.runtime, "dist/domain/evidenceBundle.js")).href
  );
  const bundle = parseEvidenceBundle(
    JSON.parse(await readFile(evidencePath, "utf8")),
  );
  report.evidence_records = bundle.records.length;
  const retained = bundle.records.find(
    (record) => record.evidence_id === remaining.evidence_id,
  );
  assert.ok(retained);
  report.retained_links = retained.evidence_links.length;
  const byId = new Set(bundle.records.map((record) => record.evidence_id));
  for (const id of retained.evidence_links) assert.ok(byId.has(id));
  report.all_source_links_resolve = true;
  if (values.history === "required") {
    const historical = bundle.records.filter(
      (record) =>
        record.operation === "health" &&
        record.parameters.facet === "historical-project-analysis-reports",
    );
    assert.equal(historical.length, 1);
    assert.equal(historical[0].normalized_result.origin, "caller-project");
    assert.ok(retained.evidence_links.includes(historical[0].evidence_id));
    report.historical_source_retained_and_linked = true;
  }
  if (values.golden) {
    const golden = JSON.parse(
      await readFile(join(values.golden, "facts.json"), "utf8"),
    );
    const labels = (rows) =>
      rows
        .map((row) => [row.address, row.name ?? row.value])
        .sort((a, b) => a[0].localeCompare(b[0], "en"));
    assert.deepEqual(labels(facts), labels(golden.procedures));
    for (const item of golden.pseudocode) {
      const fact = facts.find((row) => row.address === item.procedure);
      assert.equal(fact?.pseudocode_sha256, digest(item.result));
    }
    report.fresh_import_inventory_and_sampled_pseudocode_match = true;
  }
  if (values.control) {
    const control = JSON.parse(
      await readFile(join(values.control, "facts.json"), "utf8"),
    );
    assert.deepEqual(facts, control);
    report.control_facts_match = true;
  }
  assert.deepEqual(await fingerprint(), original);
  assert.equal(digest(await readFile(values.target)), report.target_sha256);
  report.source_unchanged = true;
  report.outcome = "passed";
} catch (cause) {
  report.outcome = "failed";
  report.failure = String(cause);
  process.exitCode = 1;
} finally {
  report.elapsed_ms = performance.now() - started;
  const published = await finalizeRetainedQueryReceipt({
    report,
    client,
    transport,
    account,
    serverLog,
    serverLogFinished,
    output: values.output,
    transcript,
  });
  if (!published) process.exitCode = 1;
}
