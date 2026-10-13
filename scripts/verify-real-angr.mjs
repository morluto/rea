#!/usr/bin/env node
import { requireMcpToolError } from "./lib/mcp-verifier-results.mjs";

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, writeFile } from "node:fs/promises";
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
  /** Claims this lane makes no observation for; listed so a passing report does not imply them. */
  unverified: [],
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
    phase = "production MCP knowledge-base edits";
    const flavor = await client.callTool({
      name: "inspect_native_decompilation_flavor",
      arguments: {},
    });
    const flavorTools = flavor.isError !== true;
    if (flavorTools) {
      const current = observe(
        toolContract("inspect_native_decompilation_flavor").outputSchema.parse(
          flavor.structuredContent,
        ),
      );
      assert.ok(current.available_flavors.includes(current.flavor));
      const changed = observe(
        await call("set_native_decompilation_flavor", { flavor: "rust" }),
      );
      assert.equal(changed.flavor, "rust");
      assert.equal(changed.previous_flavor, current.flavor);
      const rust = observe(
        await call("procedure_pseudo_code", {
          procedure: dossier.procedure.address,
        }),
      );
      assert.notEqual(rust, dossier.pseudocode);
      const restored = observe(
        await call("set_native_decompilation_flavor", {
          flavor: current.flavor,
        }),
      );
      assert.equal(restored.flavor, current.flavor);
      report.checks.push(
        "decompilation flavor inspect, set, render, and restore",
      );
    } else {
      assert.equal(requireMcpToolError(flavor).code, "capability_unavailable");
      report.checks.push(
        "decompilation flavor reported unavailable on an angr without flavor tools",
      );
    }
    const renamed = observe(
      await call("annotate_native_function", {
        procedure: dossier.procedure.address,
        name: "rea_verifier_renamed",
        comment: "REA verifier entry comment",
      }),
    );
    assert.equal(renamed.annotations.name, "rea_verifier_renamed");
    assert.equal(renamed.annotations.comment, "REA verifier entry comment");
    assert.equal(renamed.dossier.procedure.address, dossier.procedure.address);
    assert.equal(
      observe(
        await call("procedure_address", { procedure: "rea_verifier_renamed" }),
      ),
      dossier.procedure.address,
    );
    const restoredName = observe(
      await call("set_address_name", {
        address: dossier.procedure.address,
        name: dossier.procedure.name,
      }),
    );
    assert.equal(restoredName, true);
    const variable = dossier.pseudocode.match(/\b(v\d+)\b/u)?.[1];
    if (variable !== undefined) {
      const renamedVariables = observe(
        await call("rename_native_variables", {
          items: [
            {
              procedure: dossier.procedure.address,
              variable,
              new_name: "rea_verifier_variable",
            },
            {
              procedure: dossier.procedure.address,
              variable: "rea_verifier_absent",
              new_name: "unused",
            },
          ],
        }),
      );
      assert.equal(renamedVariables.total, 2);
      assert.equal(renamedVariables.succeeded, 1);
      assert.equal(renamedVariables.failed, 1);
      assert.equal(renamedVariables.results[0].new, "rea_verifier_variable");
      const retyped = observe(
        await call("set_native_variable_types", {
          items: [
            {
              procedure: dossier.procedure.address,
              variable: "rea_verifier_variable",
              type: "unsigned int",
            },
          ],
        }),
      );
      assert.equal(retyped.succeeded, 1);
      const code = observe(
        await call("procedure_pseudo_code", {
          procedure: dossier.procedure.address,
        }),
      );
      assert.ok(code.includes("rea_verifier_variable"));
      report.checks.push(
        "variable rename and retype with per-item failure and pseudocode readback",
      );
    }
    const prototypes = observe(
      await call("set_native_function_prototypes", {
        items: [{ procedure: dossier.procedure.address, return_type: "int" }],
        dry_run: true,
      }),
    );
    assert.equal(prototypes.dry_run, true);
    assert.equal(prototypes.total, 1);
    assert.equal(
      observe(
        await call("set_comment", {
          address: dossier.procedure.address,
          comment: "",
        }),
      ),
      true,
    );
    report.checks.push(
      "function annotation, name restore, prototype dry run, and comment clear",
    );
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
    try {
      if (opened) await call("close_binary", {}).catch(() => undefined);
    } finally {
      await client.close();
    }
    phase = completedPhase;
  }
};
/** PIDs of angr MCP stdio servers visible on this host, or null when it cannot list them. */
const angrServerPids = async () => {
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await promisify(execFile)("pgrep", [
      "-f",
      "--",
      "-m angr\\.mcp",
    ]);
    return new Set(stdout.split(/\s+/u).filter((pid) => pid.length > 0));
  } catch (cause) {
    // pgrep exits 1 when nothing matches; anything else means no observation.
    return cause?.code === 1 ? new Set() : null;
  }
};
const cleanup = async (serversBefore) => {
  phase = "upstream lifecycle verification";
  if (!("url" in config)) {
    const serversAfter = await angrServerPids();
    if (serversBefore === null || serversAfter === null) {
      report.unverified.push(
        "owned stdio server exit: this host cannot list angr MCP processes",
      );
      return;
    }
    const leaked = [...serversAfter].filter((pid) => !serversBefore.has(pid));
    assert.deepEqual(
      leaked,
      [],
      `angr MCP servers still running: ${leaked.join(", ")}`,
    );
    report.checks.push(
      "no angr MCP stdio server started by this lane remains running after close",
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
  const serversBefore = await angrServerPids();
  const before = await digest();
  await mcp(await cli());
  await cleanup(serversBefore);
  assert.equal(await digest(), before);
  report.checks.push("original binary bytes unchanged (SHA-256 identical)");
  report.unverified.push(
    "target execution: unchanged bytes do not establish that the target was never run; the adapter issues no execution request",
  );
  report.passed = true;
} catch (cause) {
  report.failure = {
    phase,
    message: cause instanceof Error ? cause.message : String(cause),
  };
  process.exitCode = 1;
} finally {
  if (values.report !== undefined) {
    const reportPath = resolve(values.report);
    try {
      const info = await lstat(reportPath);
      if (!info.isFile())
        throw new Error("angr report path must be a regular file");
      await chmod(reportPath, 0o600);
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw cause;
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        mode: report.mode,
        transport: report.transport,
        checks: report.checks,
        unverified: report.unverified,
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
