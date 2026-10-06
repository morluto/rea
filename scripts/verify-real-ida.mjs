#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    procedure: { type: "string", default: "rea_fixture_add" },
    "package-root": { type: "string" },
    report: { type: "string" },
  },
});
if (values.target === undefined || process.env.REA_IDA_MCP_CONFIG === undefined)
  throw new Error(
    "IDA verification requires --target and REA_IDA_MCP_CONFIG; see docs/ida-provider.md. No toolchain is installed by this lane.",
  );
const packageRoot = resolve(
  values["package-root"] ?? fileURLToPath(new URL("..", import.meta.url)),
);
const target = resolve(values.target);
const entry = join(packageRoot, "scripts", "rea.mjs");
const importBuilt = (path) =>
  import(pathToFileURL(join(packageRoot, "dist", path)).href);
const [
  { toolContract },
  { evidenceSchema },
  { functionDossierSchema },
  { readIdaConfiguration },
  { createIdaMcpConnection },
] = await Promise.all([
  importBuilt("contracts/toolContracts.js"),
  importBuilt("domain/evidence.js"),
  importBuilt("domain/hopperValues.js"),
  importBuilt("ida/IdaConfiguration.js"),
  importBuilt("ida/IdaMcpConnection.js"),
]);
const registration = readIdaConfiguration(process.env.REA_IDA_MCP_CONFIG);
if (!registration.ok) throw registration.error;
const config = registration.value;
const environment = Object.fromEntries(
  Object.entries({
    ...process.env,
    REA_ANALYSIS_PROVIDER: "ida",
    REA_LOG_LEVEL: "error",
  }).filter(([, value]) => value !== undefined),
);
const report = {
  passed: false,
  mode: config.mode,
  checks: [],
  observations: [],
};
let phase = "target admission";
const workspaces = new Set();
const databases = new Set();
const digest = async () => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
};
const observe = (input) => {
  const evidence = evidenceSchema.parse(input);
  assert.equal(evidence.provider.id, "ida");
  assert.equal(evidence.provider.version, "1");
  assert.equal(evidence.analysis_profile.parameters.cache_policy, "live");
  assert.equal(evidence.analysis_profile.parameters.engine_version, null);
  assert.ok(evidence.limitations.length > 0);
  assert.ok(
    evidence.locations.some((location) => location.kind === "artifact-path"),
  );
  if (config.mode === "headless") {
    assert.notEqual(evidence.raw_result.metadata_before.input_path, target);
    workspaces.add(dirname(evidence.raw_result.metadata_before.input_path));
    for (const observation of evidence.raw_result.observations) {
      assert.equal(typeof observation.arguments.database, "string");
      databases.add(observation.arguments.database);
    }
  }
  report.observations.push(evidence);
  return evidence.normalized_result;
};
const cli = async () => {
  phase = "production CLI function analysis";
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      entry,
      "function",
      target,
      values.procedure,
      "--provider",
      "ida",
      "--json",
    ],
    {
      env: environment,
      timeout: config.timeoutMs * 3,
      maxBuffer: 16 * 1024 * 1024,
    },
  ).catch((cause) => {
    report.failed_cli = { stdout: cause.stdout, stderr: cause.stderr };
    throw cause;
  });
  const dossier = functionDossierSchema.parse(observe(JSON.parse(stdout)));
  assert.ok(dossier.pseudocode.length > 0);
  assert.ok(dossier.assembly.length > 0);
  assert.equal(dossier.procedure.body.available, false);
  report.checks.push("production CLI and complete function Evidence");
  return dossier;
};
const mcp = async (cliDossier) => {
  const client = new Client({ name: "rea-real-ida-verifier", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "mcp"],
    env: environment,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const call = async (name, args) => {
    phase = `production MCP ${name}`;
    const result = await client.callTool(
      { name, arguments: args },
      { timeout: config.timeoutMs * 2 },
    );
    if (result.isError === true) report.failed_tool_result = result;
    assert.notEqual(result.isError, true);
    return toolContract(name).outputSchema.parse(result.structuredContent);
  };
  let opened = false;
  try {
    await client.connect(transport, { timeout: config.timeoutMs });
    await call("open_binary", { path: target, provider_id: "ida" });
    opened = true;
    const analyzed = await call("analyze_function", {
      procedure: values.procedure,
    });
    const dossier = functionDossierSchema.parse(observe(analyzed.evidence));
    assert.deepEqual(dossier.procedure, cliDossier.procedure);
    assert.equal(dossier.pseudocode, cliDossier.pseudocode);
    assert.deepEqual(dossier.assembly, cliDossier.assembly);
    assert.equal(analyzed.evidence_id, analyzed.evidence.evidence_id);
    for (const [name, args] of [
      ["list_procedures", {}],
      ["list_strings", {}],
      ["procedure_address", { procedure: dossier.procedure.name }],
      ["procedure_assembly", { procedure: dossier.procedure.address }],
      ["procedure_callees", { procedure: dossier.procedure.address }],
      ...(config.mode === "attached"
        ? [["procedure_callers", { procedure: dossier.procedure.address }]]
        : []),
      ["search_procedures", { pattern: dossier.procedure.name }],
      ["procedure_pseudo_code", { procedure: dossier.procedure.address }],
      ["read_function_instructions", { procedure: dossier.procedure.address }],
      ["search_strings", { pattern: "a.b", mode: "literal" }],
      ["xrefs", { address: dossier.procedure.address }],
    ]) {
      const result = await call(name, args);
      observe(result.evidence);
    }
    const invalid = await client.callTool({
      name: "xrefs",
      arguments: { address: "not-an-address" },
    });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.structuredContent.error.code, "invalid_request");
    await call("close_binary", {});
    opened = false;
    report.checks.push(
      "one MCP connection, target selection, analysis/search/xrefs, invalid input, and close",
    );
    report.checks.push(
      "CLI/MCP function identity, pseudocode, assembly, and raw Evidence parity",
    );
  } finally {
    const completedPhase = phase;
    if (opened) await call("close_binary", {});
    await client.close();
    phase = completedPhase;
  }
};
const cleanup = async () => {
  phase = "upstream lifecycle verification";
  const upstream = createIdaMcpConnection(config);
  try {
    await upstream.connect();
    if (config.mode === "attached") {
      const metadata = await upstream.call("get_metadata", {});
      assert.equal(metadata.sha256.toLowerCase(), await digest());
      report.checks.push(
        "existing GUI target remains open with the original input identity",
      );
    } else {
      const inventory = await upstream.call("idb_list", {});
      assert.ok(
        inventory.sessions.every(
          (session) => !databases.has(session.session_id),
        ),
      );
      for (const workspace of workspaces)
        await assert.rejects(access(workspace), { code: "ENOENT" });
      report.checks.push(
        "owned database IDs absent from upstream discovery and private workspaces removed",
      );
    }
  } finally {
    await upstream.close();
  }
};
try {
  const before = await digest();
  await mcp(await cli());
  await cleanup();
  assert.equal(await digest(), before);
  report.checks.push("original binary unchanged and never executed");
  report.passed = true;
} catch (cause) {
  report.failure = {
    phase,
    message: cause instanceof Error ? cause.message : String(cause),
  };
  process.exitCode = 1;
} finally {
  if (values.report !== undefined)
    await writeFile(
      resolve(values.report),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        mode: report.mode,
        checks: report.checks,
        ...(report.passed
          ? {}
          : {
              failed_phase: phase,
              detail: "Use --report for private local diagnostics.",
            }),
      },
      null,
      2,
    ),
  );
}
