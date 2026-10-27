/** Public stdio investigation with real ELF exports and a selected receive cap. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    ["runtime", "output", "profile", "target", "receive-bytes", "families"].map(
      (key) => [key, { type: "string" }],
    ),
  ),
});
for (const key of ["runtime", "output", "target"]) {
  assert.ok(values[key], `${key} is required`);
  values[key] = resolve(values[key]);
}
assert.ok(["full", "compact"].includes(values.profile));
const receiveBytes = Number(values["receive-bytes"] ?? 10 * 1024 * 1024);
assert.ok(Number.isSafeInteger(receiveBytes) && receiveBytes > 0);
await mkdir(values.output);
const report = {
  profile: values.profile,
  families: values.families ?? null,
  receive_bytes: receiveBytes,
  runtime: values.runtime,
  target: values.target,
  calls: [],
};
const transcript = [];
let account, client, transport, serverLog, serverLogFinished;
let phase = "initialize";
const began = performance.now();
try {
  account = await mkdtemp(join(tmpdir(), "rea-output-profile-"));
  report.target_sha256 = createHash("sha256")
    .update(await readFile(values.target))
    .digest("hex");
  report.revision = (
    await promisify(execFile)("git", [
      "-C",
      values.runtime,
      "rev-parse",
      "HEAD",
    ])
  ).stdout.trim();
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(values.runtime, "scripts/rea.mjs"), "mcp"],
    cwd: values.runtime,
    maxBufferSize: receiveBytes,
    env: {
      PATH: process.env.PATH,
      HOME: account,
      USERPROFILE: account,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=3072",
      REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
      REA_MCP_OUTPUT_SCHEMA_PROFILE: values.profile,
      ...(values.families === undefined
        ? {}
        : { REA_MCP_TOOL_FAMILIES: values.families }),
    },
    stderr: "pipe",
  });
  const start = transport.start.bind(transport);
  transport.start = async () => {
    const onerror = transport.onerror;
    transport.onerror = (cause) => {
      (report.transport_errors ??= []).push(String(cause));
      onerror?.(cause);
    };
    const receive = transport.onmessage;
    transport.onmessage = (message) => {
      transcript.push({ direction: "response", phase, message });
      receive?.(message);
    };
    await start();
  };
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    transcript.push({ direction: "request", phase, message });
    await send(message);
  };
  serverLog = createWriteStream(join(values.output, "server.log"));
  serverLogFinished = finished(serverLog);
  serverLogFinished.catch(() => {});
  transport.stderr.pipe(serverLog);
  client = new Client({
    name: "rea-output-profile-investigation",
    version: "1",
  });
  await client.connect(transport);
  phase = "discovery-cold";
  const discoveryBegan = performance.now();
  const catalog = await client.listTools({}, { timeout: 15000 });
  report.discovery_ms = performance.now() - discoveryBegan;
  report.catalog_bytes = Buffer.byteLength(JSON.stringify(catalog));
  report.tools = catalog.tools.length;
  await writeFile(join(values.output, "catalog.json"), JSON.stringify(catalog));
  const definitions = new Map(catalog.tools.map((tool) => [tool.name, tool]));
  const call = async (name, args, label) => {
    phase = label;
    const at = performance.now();
    const result = await client.callTool(
      { name, arguments: args },
      { timeout: 90000, toolDefinition: definitions.get(name) },
    );
    assert.notEqual(
      result.isError,
      true,
      `${name}: ${JSON.stringify(result).slice(0, 500)}`,
    );
    report.calls.push({ name, phase, elapsed_ms: performance.now() - at });
    return result.structuredContent;
  };
  const first = await call(
    "inspect_native_exports",
    { path: values.target, detail: "summary" },
    "exports-cold",
  );
  const repeated = await call(
    "inspect_native_exports",
    { path: values.target, detail: "summary" },
    "exports-warm",
  );
  const parentId = first.normalized_result.parent_evidence_id;
  assert.equal(repeated.normalized_result.parent_evidence_id, parentId);
  report.parent_evidence_id = parentId;
  const count = first.normalized_result.summary.export_count;
  assert.ok(count > 1);
  const page = await call(
    "inspect_analysis_view",
    {
      source: { kind: "retained-evidence", evidence_id: parentId },
      view: {
        kind: "native-exports",
        collection: "exports",
        indices: [0, count - 1],
        fields: ["name"],
        limit: 2,
      },
    },
    "selected-exports",
  );
  assert.deepEqual(
    page.normalized_result.items.map((item) => item.source_index),
    [0, count - 1],
  );
  const bundlePath = join(values.output, "complete-evidence.json");
  await call("export_evidence_bundle", { path: bundlePath }, "complete-export");
  phase = "discovery-warm";
  const warmAt = performance.now();
  assert.deepEqual(await client.listTools(), catalog);
  report.warm_discovery_ms = performance.now() - warmAt;
  // Release the server ledger before parsing the complete exported records.
  await client.close();
  await transport.close();
  const { parseEvidenceBundle } = await import(
    pathToFileURL(join(values.runtime, "dist/domain/evidenceBundle.js")).href
  );
  const bundle = parseEvidenceBundle(
    JSON.parse(await readFile(bundlePath, "utf8")),
  );
  const parent = bundle.records.find(
    (record) => record.evidence_id === parentId,
  );
  assert.ok(parent);
  const rows = parent.normalized_result.exports;
  assert.equal(rows.length, count);
  for (const row of page.normalized_result.items) {
    assert.equal(row.name, rows[row.source_index].name);
  }
  const nm = await promisify(execFile)(
    "nm",
    [
      "--dynamic",
      "--defined-only",
      "--without-symbol-versions",
      "--format=posix",
      values.target,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const symbols = nm.stdout
    .trim()
    .split("\n")
    .map((line) => line.split(/\s+/u));
  const names = new Set(symbols.map(([name]) => name));
  const coordinates = new Set(
    symbols.map(([name, , value]) => `${name}:${BigInt(`0x${value}`)}`),
  );
  for (const row of rows)
    assert.ok(
      coordinates.has(`${row.name}:${BigInt(row.value)}`),
      `GNU nm did not corroborate ${row.name} at ${row.value}`,
    );
  const observed = new Set(rows.map((row) => row.name));
  for (const name of names)
    assert.ok(observed.has(name), `REA omitted GNU nm export ${name}`);
  report.export_count = count;
  report.nm_unique_names = names.size;
  report.facts_sha256 = createHash("sha256")
    .update(JSON.stringify(parent))
    .digest("hex");
  report.outcome = "passed";
} catch (cause) {
  report.outcome = "failed";
  report.failure = String(cause);
  process.exitCode = 1;
} finally {
  report.elapsed_ms = performance.now() - began;
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
