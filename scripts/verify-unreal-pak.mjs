import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { absoluteCallerPath } from "../dist/filesystem/callerPath.js";
import { toolContract } from "../dist/contracts/toolContracts.js";
import { analysisViewResultSchema } from "../dist/domain/analysisView/analysisView.js";
import { ArtifactResourceScope } from "../dist/artifacts/ArtifactResourceScope.js";
import { artifactMcpCall } from "./lib/artifact-e2e.mjs";
import { mcpTextValue } from "./lib/mcp-verifier-results.mjs";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import { hashVerifierFile } from "./lib/verifier-file-resources.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: npm run verify:unreal:pak -- [--pak PATH]\nPATH is a caller-owned Unreal Engine .pak file (versions 1 to 12). Without --pak, only the advertised contract is verified.",
  );
  process.exit(0);
}
if (!(args.length === 0 || (args.length === 2 && args[0] === "--pak")))
  throw new Error("Expected --pak PATH");
const path = args[1] === undefined ? null : absoluteCallerPath(args[1]);
const operation = "inspect_unreal_pak";
const contract = toolContract(operation);
const entrypoint = resolve("scripts/rea.mjs");
const execute = promisify(execFile);
const client = new Client({ name: "unreal-pak-verifier", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      ([, value]) => typeof value === "string",
    ),
  ),
  stderr: "pipe",
});
transport.stderr?.resume();
const call = async (name, input) => {
  const response = await artifactMcpCall(
    client,
    { name, arguments: input },
    { timeout: 120_000 },
  );
  assert.notEqual(response.isError, true, mcpTextValue(response));
  return JSON.parse(mcpTextValue(response));
};
const entryPage = async (evidenceId) =>
  analysisViewResultSchema.parse(
    (
      await call("inspect_analysis_view", {
        source: { kind: "retained-evidence", evidence_id: evidenceId },
        view: { kind: "unreal-pak", collection: "entries", limit: 16 },
      })
    ).normalized_result,
  );
const firstEntries = (report) =>
  report.entries.slice(0, 16).map((entry, index) => ({ index, ...entry }));
const resources = new ArtifactResourceScope();
await withVerifierCleanup(async () => {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert(tools.some((tool) => tool.name === operation));
  if (path === null)
    console.log("[unverified] Pak inspection: no --pak was supplied");
  else {
    const identity = await hashVerifierFile(path, resources);
    const started = performance.now();
    const { stdout } = await execute(
      process.execPath,
      [entrypoint, "inspect-unreal-pak", path, "--json"],
      { timeout: 300_000, maxBuffer: 256 * 1024 * 1024 },
    );
    const cliMs = Math.round(performance.now() - started);
    const cli = contract.outputSchema.parse(JSON.parse(stdout));
    const report = cli.normalized_result;
    assert.equal(report.artifact.path, path);
    assert.equal(report.artifact.sha256, identity.sha256);
    const complete = await artifactMcpCall(
      client,
      { name: operation, arguments: { path, detail: "complete" } },
      { timeout: 300_000 },
    );
    if (complete.isError === true) {
      // Large indexes exceed the stdio budget; the result must stay
      // retained and addressable rather than truncated.
      const { error } = JSON.parse(mcpTextValue(complete));
      assert.equal(error.code, "resource_constraint");
      const limits = error.details.reported_limits;
      assert.equal(limits.boundary, "mcp-response");
      assert.equal(limits.evidence_reference.kind, "retained-evidence");
      assert.match(limits.evidence_reference.evidence_id, /^ev_[a-f0-9]{64}$/u);
      // Page the refused call's own record, not a later inspection.
      assert.deepEqual(
        (await entryPage(limits.evidence_reference.evidence_id)).items,
        firstEntries(report),
      );
      console.log(
        "[ok] MCP complete delivery refused at the stdio budget; its retained Evidence pages like the CLI report",
      );
    } else {
      const mcp = contract.outputSchema.parse(
        JSON.parse(mcpTextValue(complete)),
      );
      assert.deepEqual(mcp.normalized_result, report);
      console.log("[ok] CLI/MCP complete Evidence parity");
    }
    if (report.index.state === "decoded") {
      if (report.index.entry_count !== null)
        assert.equal(report.entries.length, report.index.entry_count);
      for (const entry of report.entries)
        assert.ok(
          entry.offset + entry.size <= report.footer.index.offset ||
            entry.size === 0,
          `entry ${entry.path} reaches past the data area`,
        );
      console.log(
        "[ok] entry count matches the index and every entry lies in the data area",
      );
    }
    const summary = contract.outputSchema.parse(
      await call(operation, { path, detail: "summary" }),
    ).normalized_result;
    assert.equal(summary.summary.counts.entries, report.entries.length);
    assert.equal(summary.summary.counts.issues, report.issues.length);
    for (const issue of report.issues)
      console.log(`[issue] ${issue.kind} at ${issue.offset}: ${issue.message}`);
    assert.deepEqual(
      (await entryPage(summary.parent_evidence_id)).items,
      firstEntries(report),
    );
    assert.deepEqual(
      await hashVerifierFile(path, resources),
      identity,
      "Input pak must remain unchanged",
    );
    console.log(
      `[ok] summary and page parity; pak layout ${report.footer.layout}, ${report.entries.length} entries, ${report.issues.length} issues; complete Evidence ${Buffer.byteLength(stdout)} bytes, summary ${Buffer.byteLength(JSON.stringify(summary))} bytes; CLI ${cliMs} ms`,
    );
  }
}, [() => client.close(), () => transport.close(), () => resources.close()]);
console.log("All asserted Unreal pak CLI/MCP checks passed");
