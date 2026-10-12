import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const { values } = parseArgs({
  options: {
    "runtime-root": { type: "string" },
    revision: { type: "string" },
    bundle: { type: "string" },
    "inspection-reply": { type: "string" },
    output: { type: "string" },
  },
});
for (const key of ["runtime-root", "bundle", "inspection-reply", "output"])
  assert.ok(values[key] && isAbsolute(values[key]), `Supply --${key} ABS`);
assert.ok(values.revision);
await mkdir(values.output, { mode: 0o700 });
const sha = (value) => createHash("sha256").update(value).digest("hex");
const bundleBytes = await readFile(values.bundle);
const oldBundle = JSON.parse(bundleBytes.toString("utf8"));
const oldWasm = oldBundle.records.find(
  (record) => record.operation === "inspect_wasm_artifact",
);
assert.ok(oldWasm);
const inspectionBytes = await readFile(values["inspection-reply"]);
const oldInspection = JSON.parse(
  inspectionBytes.toString("utf8"),
).structuredContent;
assert.equal(oldInspection.operation, "inspect_artifact");
const definitions = new Map();
const client = new Client({
  name: "rea-real-evidence-migration",
  version: "1",
});
// An absent explicitly selected WABT directory makes accidental re-analysis
// fail. Imported/portable views must operate on existing Evidence alone.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(values["runtime-root"], "scripts/rea.mjs"), "mcp"],
  env: {
    ...process.env,
    REA_LOG_LEVEL: "silent",
    NODE_OPTIONS: "--max-old-space-size=512",
    REA_WABT_BIN_DIRECTORY: resolve(values.output, "absent-wabt"),
  },
  stderr: "pipe",
});
const calls = [];
const call = async (name, arguments_) => {
  const reply = await client.callTool(
    { name, arguments: arguments_ },
    { toolDefinition: definitions.get(name), timeout: 120_000 },
  );
  await writeFile(
    resolve(values.output, `call-${calls.length + 1}.json`),
    JSON.stringify(reply),
  );
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  const result = reply.structuredContent ?? JSON.parse(reply.content[0].text);
  calls.push({
    name,
    arguments:
      name === "inspect_analysis_view" && arguments_.source.kind === "inline"
        ? {
            source: {
              kind: "inline",
              original_evidence_id: arguments_.source.evidence.evidence_id,
            },
            view: arguments_.view,
          }
        : arguments_,
    evidence_id: result.evidence_id ?? null,
  });
  return result;
};
let report;
try {
  await client.connect(transport);
  transport.stderr?.resume();
  for (const definition of (await client.listTools()).tools)
    definitions.set(definition.name, definition);
  await call("import_evidence_bundle", { path: values.bundle });
  const source = {
    kind: "retained-evidence",
    evidence_id: oldWasm.evidence_id,
  };
  const summary = await call("inspect_analysis_view", {
    source,
    view: { kind: "summary" },
  });
  const exports = await call("inspect_analysis_view", {
    source,
    view: { kind: "wasm", facet: "exports", offset: 0, limit: 4 },
  });
  assert.equal(
    summary.normalized_result.parent_evidence_id,
    oldWasm.evidence_id,
  );
  assert.equal(summary.subject.digest.sha256, oldWasm.subject.digest.sha256);
  assert.equal(
    summary.normalized_result.summary.wat.sha256,
    oldWasm.normalized_result.wat.sha256,
  );
  assert.deepEqual(
    exports.normalized_result.item,
    oldWasm.normalized_result.exports.slice(0, 4),
  );
  const inventory = await call("inspect_analysis_view", {
    source: { kind: "inline", evidence: oldInspection },
    view: { kind: "summary" },
  });
  assert.equal(
    inventory.normalized_result.parent_evidence_id,
    oldInspection.evidence_id,
  );
  const oldAtomic = oldInspection.normalized_result.substeps[0].evidence;
  assert.deepEqual(
    inventory.normalized_result.summary.manifest,
    oldAtomic.normalized_result.manifest,
  );
  assert.deepEqual(inventory.normalized_result.summary.inventory_evidence_ids, [
    oldAtomic.evidence_id,
  ]);
  const exportedPath = resolve(values.output, "exported-after-import.json");
  await call("export_evidence_bundle", { path: exportedPath });
  const exported = JSON.parse(await readFile(exportedPath, "utf8"));
  assert.deepEqual(
    exported.records.find(
      (record) => record.evidence_id === oldWasm.evidence_id,
    ),
    oldWasm,
  );
  assert.equal(sha(await readFile(values.bundle)), sha(bundleBytes));
  assert.equal(
    sha(await readFile(values["inspection-reply"])),
    sha(inspectionBytes),
  );
  report = {
    runtime_revision: values.revision,
    original_bundle_sha256: sha(bundleBytes),
    original_inspection_reply_sha256: sha(inspectionBytes),
    source_files_unchanged: true,
    imported_wasm_source_evidence_id: oldWasm.evidence_id,
    original_wasm_record_preserved_exactly: true,
    typed_summary_and_first4_exports_match: true,
    portable_old_inspection_and_atomic_inventory_identity_preserved: true,
    original_inventory_evidence_id: oldAtomic.evidence_id,
    calls,
    scope:
      "Actual old complete Evidence imported or passed inline to the new runtime; original authentication, IDs, records, source bytes and selected facts preserved. WABT is unavailable and no producer analysis is requested. Existing file import/export is used, not an engine database cache.",
  };
} finally {
  await client.close();
}
await writeFile(
  resolve(values.output, "summary.json"),
  JSON.stringify(report, null, 2),
);
process.stdout.write(JSON.stringify(report) + "\n");
