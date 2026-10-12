#!/usr/bin/env node
import { requireMcpToolError } from "./lib/mcp-verifier-results.mjs";

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    procedure: { type: "string", default: "main" },
    "package-root": { type: "string" },
    report: { type: "string" },
  },
});
if (
  values.target === undefined ||
  (process.env.REA_ANGR_PYTHON === undefined &&
    process.env.REA_ANGR_MCP_CONFIG === undefined)
)
  throw new Error(
    "angr verification requires --target and REA_ANGR_PYTHON or REA_ANGR_MCP_CONFIG; see docs/angr-provider.md. No toolchain is installed by this lane.",
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
  { readAngrConfiguration },
  { createAngrMcpConnection },
] = await Promise.all([
  importBuilt("contracts/toolContracts.js"),
  importBuilt("domain/evidence.js"),
  importBuilt("domain/hopperValues.js"),
  importBuilt("angr/AngrConfiguration.js"),
  importBuilt("angr/AngrMcpConnection.js"),
]);
const registration = readAngrConfiguration({
  mcpConfigPath: process.env.REA_ANGR_MCP_CONFIG,
  pythonPath: process.env.REA_ANGR_PYTHON,
});
if (!registration.ok) throw registration.error;
const config = registration.value;
const environment = Object.fromEntries(
  Object.entries({
    ...process.env,
    REA_ANALYSIS_PROVIDER: "angr",
    REA_LOG_LEVEL: "error",
  }).filter(([, value]) => value !== undefined),
);
const report = {
  passed: false,
  mode: config.mode,
  transport: "command" in config ? "stdio" : "http",
  checks: [],
  observations: [],
};
let phase = "target admission";
const projects = new Set();
const digest = async () => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
};
const observe = (input) => {
  const evidence = evidenceSchema.parse(input);
  assert.equal(evidence.provider.id, "angr");
  assert.equal(evidence.provider.version, "1");
  assert.equal(evidence.analysis_profile.parameters.cache_policy, "live");
  assert.equal(evidence.analysis_profile.parameters.engine_version, null);
  assert.ok(evidence.limitations.length > 0);
  assert.ok(
    evidence.locations.some((location) => location.kind === "artifact-path"),
  );
  assert.equal(typeof evidence.raw_result.project?.project_id, "string");
  projects.add(evidence.raw_result.project.project_id);
  for (const observation of evidence.raw_result.observations)
    assert.equal(
      observation.arguments.project_id,
      evidence.raw_result.project.project_id,
    );
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
      "angr",
      "--json",
    ],
    {
      env: environment,
      timeout: config.startupTimeoutMs + config.timeoutMs * 3,
      maxBuffer: 64 * 1024 * 1024,
    },
  ).catch((cause) => {
    report.failed_cli = { stdout: cause.stdout, stderr: cause.stderr };
    throw cause;
  });
  const dossier = functionDossierSchema.parse(observe(JSON.parse(stdout)));
  assert.ok(dossier.pseudocode.length > 0);
  assert.ok(dossier.assembly.length > 0);
  assert.equal(dossier.procedure.body.available, true);
  assert.equal(dossier.procedure.body.contains_entry, true);
  report.checks.push("production CLI and complete function Evidence");
  return dossier;
};
const mcp = async (cliDossier) => {
  const client = new Client({ name: "rea-real-angr-verifier", version: "1" });
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
      { timeout: config.startupTimeoutMs + config.timeoutMs },
    );
    if (result.isError === true) report.failed_tool_result = result;
    assert.notEqual(result.isError, true);
    return toolContract(name).outputSchema.parse(result.structuredContent);
  };
  let opened = false;
  try {
    await client.connect(transport, { timeout: config.timeoutMs });
    await call("open_binary", { path: target, provider_id: "angr" });
    opened = true;
    const analyzed = await call("analyze_function", {
      procedure: values.procedure,
    });
    const dossier = functionDossierSchema.parse(observe(analyzed));
    assert.deepEqual(dossier.procedure, cliDossier.procedure);
    assert.equal(dossier.pseudocode, cliDossier.pseudocode);
    assert.deepEqual(dossier.assembly, cliDossier.assembly);
    assert.equal(analyzed.relationship_coverage?.status, "partial");
    for (const [name, args] of [
      ["list_procedures", {}],
      ["list_strings", {}],
      ["procedure_address", { procedure: dossier.procedure.name }],
      ["procedure_assembly", { procedure: dossier.procedure.address }],
      ["procedure_callees", { procedure: dossier.procedure.address }],
      ["procedure_callers", { procedure: dossier.procedure.address }],
      ["search_procedures", { pattern: dossier.procedure.name }],
      ["procedure_pseudo_code", { procedure: dossier.procedure.address }],
      ["read_function_instructions", { procedure: dossier.procedure.address }],
      ["search_strings", { pattern: "a.b", mode: "literal" }],
      ["xrefs", { address: dossier.procedure.address }],
    ]) {
      const result = await call(name, args);
      const normalized = observe(result);
      if (name === "procedure_address")
        assert.equal(normalized, dossier.procedure.address);
      if (name === "search_procedures")
        assert.ok(
          normalized.some(({ value }) => value === dossier.procedure.name),
        );
    }
    const invalid = await client.callTool({
      name: "xrefs",
      arguments: { address: "not-an-address" },
    });
    assert.equal(invalid.isError, true);
    assert.equal(requireMcpToolError(invalid).code, "invalid_request");
    const missing = await client.callTool({
      name: "procedure_address",
      arguments: { procedure: "rea_verifier_absent_procedure" },
    });
    assert.equal(missing.isError, true);
    assert.equal(requireMcpToolError(missing).code, "invalid_request");
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
  if (!("url" in config)) {
    report.checks.push(
      "owned stdio server processes ended with their REA sessions",
    );
    return;
  }
  const upstream = createAngrMcpConnection(config, process.env);
  try {
    await upstream.connect();
    const inventory = await upstream.call("list_projects", {});
    assert.ok(
      inventory.projects.every(({ project_id }) => !projects.has(project_id)),
    );
    report.checks.push("owned project IDs absent from the attached server");
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
        transport: report.transport,
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
