import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const { values } = parseArgs({
  options: {
    "runtime-root": { type: "string" },
    revision: { type: "string" },
    bundle: { type: "string" },
    output: { type: "string" },
  },
});
for (const key of ["runtime-root", "bundle", "output"])
  assert.ok(values[key] && isAbsolute(values[key]), `Supply --${key} ABS`);
assert.ok(values.revision);
await mkdir(values.output, { mode: 0o700 });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = await readFile(values.bundle);
const original = JSON.parse(bytes.toString("utf8"));
const parents = original.records.filter(
  (record) => record.operation === "inspect_evm_interface",
);
assert.ok(parents.length > 0, "Select a bundle containing old EVM Evidence");
const entrypoint = resolve(values["runtime-root"], "scripts/rea.mjs");
const environment = {
  ...process.env,
  REA_LOG_LEVEL: "silent",
  NODE_OPTIONS: "--max-old-space-size=512",
  // If a view accidentally starts analysis, its required limiter is unavailable.
  REA_EVM_PRLIMIT_COMMAND: resolve(values.output, "absent-prlimit"),
};
const client = new Client({ name: "rea-old-evm-retention", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env: environment,
  stderr: "pipe",
});
const definitions = new Map();
const calls = [];
const call = async (name, args) => {
  const definition = definitions.get(name);
  assert.ok(definition, `Missing named contract ${name}`);
  const reply = await client.callTool(
    { name, arguments: args },
    { toolDefinition: definition, timeout: 60_000 },
  );
  await writeFile(
    resolve(values.output, `call-${calls.length + 1}.json`),
    JSON.stringify(reply),
    { flag: "wx", mode: 0o600 },
  );
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  const text = JSON.parse(reply.content.find((x) => x.type === "text").text);
  assert.deepEqual(reply.structuredContent, text);
  calls.push({ name, arguments: args, evidence_id: text.evidence_id ?? null });
  return text;
};
const checked = [];
try {
  await client.connect(transport);
  transport.stderr?.resume();
  for (const definition of (await client.listTools()).tools)
    definitions.set(definition.name, definition);
  await call("import_evidence_bundle", { path: values.bundle });
  const imported = (await call("get_evidence_bundle", {})).result.records;
  for (const parent of parents) {
    assert.deepEqual(
      imported.find((record) => record.evidence_id === parent.evidence_id),
      parent,
    );
    const source = {
      kind: "retained-evidence",
      evidence_id: parent.evidence_id,
    };
    const view = await call("inspect_analysis_view", {
      source,
      view: { kind: "summary" },
    });
    const { hex, ...bytecode } = parent.normalized_result.bytecode;
    const { stdout, ...diagnostics } = parent.normalized_result.diagnostics;
    assert.deepEqual(view.normalized_result.summary, {
      ...parent.normalized_result,
      bytecode,
      diagnostics: { ...diagnostics, stdout_code_units: stdout.length },
    });
    assert.equal(view.normalized_result.parent_evidence_id, parent.evidence_id);
    assert.notEqual(view.evidence_id, parent.evidence_id);
    assert.deepEqual(view.evidence_links, [parent.evidence_id]);
    for (const [facet, expected] of [
      ["functions", parent.normalized_result.functions.slice(0, 2)],
      ["bytecode_hex", { text: hex.slice(0, 64), unit: "utf16-code-units" }],
    ]) {
      const page = await call("inspect_analysis_view", {
        source,
        view: {
          kind: "evm",
          facet,
          offset: 0,
          limit: facet === "functions" ? 2 : 64,
        },
      });
      assert.deepEqual(page.normalized_result.item, expected);
      assert.equal(
        page.normalized_result.parent_evidence_id,
        parent.evidence_id,
      );
      assert.deepEqual(page.evidence_links, [parent.evidence_id]);
    }
    const inlinePath = resolve(values.output, `inline-${checked.length}.json`);
    await writeFile(
      inlinePath,
      JSON.stringify({
        source: { kind: "inline", evidence: parent },
        view: { kind: "summary" },
      }),
      { flag: "wx", mode: 0o600 },
    );
    const result = await promisify(execFile)(
      process.execPath,
      [entrypoint, "inspect-analysis-view", inlinePath, "--json"],
      { env: environment, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const inline = JSON.parse(result.stdout);
    assert.equal(
      inline.normalized_result.parent_evidence_id,
      parent.evidence_id,
    );
    assert.deepEqual(
      inline.normalized_result.summary,
      view.normalized_result.summary,
    );
    checked.push(parent.evidence_id);
  }
  const path = resolve(values.output, "exported.json");
  await call("export_evidence_bundle", { path });
  const exported = JSON.parse(await readFile(path, "utf8"));
  for (const record of original.records)
    assert.deepEqual(
      exported.records.find((x) => x.evidence_id === record.evidence_id),
      record,
    );
  assert.deepEqual(await readFile(values.bundle), bytes);
} finally {
  await client.close();
}
const report = {
  runtime_revision: values.revision,
  original_bundle_sha256: sha(bytes),
  checked_original_evidence_ids: checked,
  original_records_and_source_bytes_unchanged: true,
  exact_summaries_pages_and_cli_inline_pass: true,
  calls,
  scope:
    "Old EVM Evidence through actual public SDK/CLI with an unavailable analysis limiter; original inferred facts, explicit unknowns, parent identities and export records preserved. Caller supplies the frozen runtime revision; this is migration verification, not a performance pair.",
};
await writeFile(
  resolve(values.output, "summary.json"),
  JSON.stringify(report, null, 2),
  { flag: "wx", mode: 0o600 },
);
process.stdout.write(JSON.stringify(report) + "\n");
