/** Equivalent bounded Ghidra investigations with fresh import or an existing project. */
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
    [
      "runtime",
      "output",
      "profile",
      "target",
      "receive-bytes",
      "families",
      "ghidra",
      "java",
      "project",
      "program",
      "control",
      "expected",
      "heap",
      "history",
    ].map((key) => [key, { type: "string" }]),
  ),
});
for (const key of ["runtime", "output", "target", "ghidra", "java"]) {
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
  project: values.project ?? null,
  expected: values.expected ?? "success",
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
      GHIDRA_INSTALL_DIR: values.ghidra,
      JAVA_HOME: values.java,
      GHIDRA_HEADLESS_MAXMEM: values.heap ?? "1536M",
      JAVA_TOOL_OPTIONS: "-XX:ActiveProcessorCount=2",
      REA_GHIDRA_STARTUP_TIMEOUT_MS: "600000",
      ...(values.project === undefined
        ? {}
        : { REA_GHIDRA_PROJECT_PATH: values.project }),
      ...(values.program === undefined
        ? {}
        : { REA_GHIDRA_PROGRAM_NAME: values.program }),
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
      { timeout: 900000, toolDefinition: definitions.get(name) },
    );
    assert.notEqual(
      result.isError,
      true,
      `${name}: ${JSON.stringify(result).slice(0, 500)}`,
    );
    report.calls.push({ name, phase, elapsed_ms: performance.now() - at });
    return result.structuredContent;
  };
  let sourceCommitment, projectResources, resolveProject;
  if (values.project !== undefined) {
    ({ resolveGhidraProject: resolveProject } = await import(
      pathToFileURL(
        join(values.runtime, "dist/ghidra/GhidraProjectSnapshot.js"),
      ).href
    ));
    const { ArtifactResourceScope } = await import(
      pathToFileURL(
        join(values.runtime, "dist/artifacts/ArtifactResourceScope.js"),
      ).href
    );
    projectResources = new ArtifactResourceScope();
    try {
      sourceCommitment = await resolveProject(
        {
          path: values.project,
          ...(values.program === undefined
            ? {}
            : { programName: values.program }),
        },
        { path: values.target },
        projectResources,
      );
    } finally {
      await projectResources.close();
    }
    report.project_sha256 = sourceCommitment.sha256;
  }
  await call(
    "open_binary",
    { path: values.target, provider_id: "ghidra" },
    "open",
  );
  if (["mismatch", "stale"].includes(values.expected)) {
    phase = "mismatched-project";
    const marker =
      values.expected === "stale" ? await readFile(values.project) : undefined;
    if (marker !== undefined)
      await writeFile(
        values.project,
        Buffer.concat([marker, Buffer.from("\n")]),
      );
    let rejected;
    try {
      rejected = await client.callTool(
        { name: "list_procedures", arguments: { detail: "summary" } },
        { timeout: 900000, toolDefinition: definitions.get("list_procedures") },
      );
    } finally {
      if (marker !== undefined) await writeFile(values.project, marker);
    }
    assert.equal(rejected.isError, true);
    assert.match(
      JSON.stringify(rejected),
      values.expected === "stale"
        ? /changed while being read|artifact.changed/iu
        : /imported-byte digest does not match/u,
    );
    await writeFile(
      join(values.output, "rejection.json"),
      JSON.stringify(rejected),
    );
    report[`rejected_${values.expected}`] = true;
  } else {
    const summary = await call(
      "list_procedures",
      { detail: "summary" },
      "inventory-cold",
    );
    const parentId = summary.normalized_result.parent_evidence_id;
    const count = summary.normalized_result.summary.row_count;
    assert.ok(count > 0);
    report.procedure_count = count;
    const page = await call(
      "inspect_analysis_view",
      {
        source: { kind: "retained-evidence", evidence_id: parentId },
        view: {
          kind: "native-inventory",
          offset: Math.floor(count / 2),
          limit: Math.min(count - Math.floor(count / 2), 32),
          fields: ["value", "procedure"],
        },
      },
      "selected-procedures",
    );
    const selected = page.normalized_result.rows
      .map((row) => row.record)
      .filter(
        (row) =>
          row.procedure?.external === false && row.procedure?.thunk === false,
      )
      .slice(0, 2);
    assert.equal(selected.length, 2);
    await call("binary_overview", {}, "overview");
    for (const row of selected)
      await call(
        "procedure_pseudo_code",
        { procedure: row.address },
        `pseudocode:${row.address}`,
      );
    const warm = await call(
      "list_procedures",
      { detail: "summary" },
      "inventory-warm",
    );
    assert.equal(warm.normalized_result.parent_evidence_id, parentId);
    const bundlePath = join(values.output, "complete-evidence.json");
    await call(
      "export_evidence_bundle",
      { path: bundlePath },
      "complete-export",
    );
    await call("close_binary", {}, "close");
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
    if (values.history === "required") {
      const historical = bundle.records.filter(
        (record) =>
          record.operation === "health" &&
          record.parameters.facet === "historical-project-analysis-reports",
      );
      assert.equal(historical.length, 1);
      assert.equal(historical[0].normalized_result.origin, "caller-project");
      assert.ok(historical[0].normalized_result.analysis_seeds);
      assert.ok(historical[0].normalized_result.disabled_analyzers);
      report.historical_evidence_id = historical[0].evidence_id;
      report.historical_evidence_linked =
        parent.evidence_links?.includes(historical[0].evidence_id) ?? false;
    }
    assert.equal(parent.normalized_result.length, count);
    const facts = {
      procedures: parent.normalized_result,
      pseudocode: bundle.records
        .filter((record) => record.operation === "procedure_pseudo_code")
        .map((record) => ({
          procedure: record.parameters.procedure,
          result: record.normalized_result,
        })),
    };
    facts.pseudocode.sort((left, right) =>
      left.procedure < right.procedure
        ? -1
        : left.procedure > right.procedure
          ? 1
          : 0,
    );
    report.facts_sha256 = createHash("sha256")
      .update(JSON.stringify(facts))
      .digest("hex");
    await writeFile(join(values.output, "facts.json"), JSON.stringify(facts));
    report.analysis_profile = parent.analysis_profile;
    assert.equal(parent.subject.digest.sha256, report.target_sha256);
    if (sourceCommitment !== undefined) {
      assert.equal(
        parent.analysis_profile.parameters.existing_project.sha256,
        sourceCommitment.sha256,
      );
      assert.ok(
        parent.limitations.some(
          (value) =>
            value.includes("completeness") && value.includes("unknown"),
        ),
      );
    }
    if (values.control !== undefined) {
      const control = JSON.parse(
        await readFile(join(values.control, "facts.json"), "utf8"),
      );
      assert.deepEqual(facts, control);
    }
  }
  if (sourceCommitment !== undefined) {
    const { ArtifactResourceScope } = await import(
      pathToFileURL(
        join(values.runtime, "dist/artifacts/ArtifactResourceScope.js"),
      ).href
    );
    const resources = new ArtifactResourceScope();
    let after;
    try {
      after = await resolveProject(
        {
          path: values.project,
          ...(values.program === undefined
            ? {}
            : { programName: values.program }),
        },
        { path: values.target },
        resources,
      );
    } finally {
      await resources.close();
    }
    assert.deepEqual(after, sourceCommitment);
    report.original_project_unchanged = true;
  }
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
