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
    procedure: { type: "string" },
    "second-procedure": { type: "string" },
    "second-marker": { type: "string" },
    "expected-string": { type: "string" },
    "expected-xref": { type: "string" },
    "package-root": { type: "string" },
    report: { type: "string" },
  },
});
if (
  values.target === undefined ||
  values.procedure === undefined ||
  process.env.REA_BINARY_NINJA_MCP_CONFIG === undefined
)
  throw new Error(
    "Binary Ninja verification requires --target, --procedure and REA_BINARY_NINJA_MCP_CONFIG, with the target open in the Binary Ninja GUI and its MCP server started; see docs/binary-ninja.md. No toolchain is installed by this lane.",
  );
if (
  (values["second-procedure"] === undefined) !==
    (values["second-marker"] === undefined) ||
  values["second-marker"] === ""
)
  throw new Error(
    "Binary Ninja verification requires --second-procedure and a nonempty --second-marker together; choose a marker unique to the second function's pseudocode.",
  );
if (values["expected-string"] === "" || values["expected-xref"] === "")
  throw new Error("Binary Ninja verification oracles must be nonempty.");
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
  { readBinaryNinjaConfiguration },
  { createBinaryNinjaMcpConnection },
  { binaryNinjaAddressSchema, binaryNinjaActiveViewSchema },
] = await Promise.all([
  importBuilt("contracts/toolContracts.js"),
  importBuilt("domain/evidence.js"),
  importBuilt("domain/native/functionDossier.js"),
  importBuilt("binaryNinja/BinaryNinjaConfiguration.js"),
  importBuilt("binaryNinja/BinaryNinjaMcpConnection.js"),
  importBuilt("binaryNinja/BinaryNinjaProtocolValues.js"),
]);
const { ArtifactResourceScope } = await importBuilt(
  "artifacts/ArtifactResourceScope.js",
);
const { AnalysisCleanupLease } = await importBuilt(
  "artifacts/AnalysisCleanupLease.js",
);
const registrationResources = new ArtifactResourceScope();
let registration;
try {
  registration = await readBinaryNinjaConfiguration(
    process.env.REA_BINARY_NINJA_MCP_CONFIG,
    {
      resourceScope: {
        run: (operation) => registrationResources.run(operation),
        retain: (owner, resource) =>
          registrationResources.retain({
            kind: "lease",
            resource,
            lease: AnalysisCleanupLease.forCloseOwner(owner, resource),
          }),
      },
    },
  );
} finally {
  await registrationResources.close();
}
if (!registration.ok) throw registration.error;
const config = registration.value;
const environment = Object.fromEntries(
  Object.entries({
    ...process.env,
    REA_ANALYSIS_PROVIDER: "binary-ninja",
    REA_LOG_LEVEL: "error",
  }).filter(([, value]) => value !== undefined),
);
const report = {
  passed: false,
  checks: [],
  observations: [],
  unverified: [],
};
const expectedXref =
  values["expected-xref"] === undefined
    ? undefined
    : binaryNinjaAddressSchema.parse(values["expected-xref"]);
let phase = "target admission";
const digest = async () => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
};
const observe = (input) => {
  const evidence = evidenceSchema.parse(input);
  assert.equal(evidence.provider.id, "binary-ninja");
  assert.equal(evidence.provider.version, "1");
  assert.equal(evidence.analysis_profile.parameters.cache_policy, "live");
  assert.equal(evidence.analysis_profile.parameters.engine_version, null);
  assert.ok(evidence.limitations.length > 0);
  assert.ok(
    evidence.locations.some((location) => location.kind === "artifact-path"),
  );
  assert.deepEqual(
    evidence.raw_result.view_before,
    evidence.raw_result.view_after,
  );
  report.observations.push(evidence);
  return evidence.normalized_result;
};
/** Read the shared MCP selection REA must restore when it closes. */
const activeView = async () => {
  const upstream = createBinaryNinjaMcpConnection(config);
  try {
    await upstream.connect();
    const reply = await upstream.call("bn_binary_view_get_active", {});
    return binaryNinjaActiveViewSchema.parse(reply.structured).binaryView
      ?.handle;
  } finally {
    await upstream.close();
  }
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
      "binary-ninja",
      "--json",
    ],
    {
      env: environment,
      timeout: config.timeoutMs * 3,
      maxBuffer: 64 * 1024 * 1024,
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
  const client = new Client({
    name: "rea-real-binary-ninja-verifier",
    version: "1",
  });
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
    await call("open_binary", { path: target, provider_id: "binary-ninja" });
    opened = true;
    const analyzed = await call("analyze_function", {
      procedure: values.procedure,
      detail: "complete",
    });
    const dossier = functionDossierSchema.parse(observe(analyzed));
    assert.deepEqual(dossier.procedure, cliDossier.procedure);
    assert.equal(dossier.pseudocode, cliDossier.pseudocode);
    assert.deepEqual(dossier.assembly, cliDossier.assembly);
    for (const [name, args] of [
      ["list_procedures", {}],
      ["list_strings", {}],
      ["list_documents", {}],
      ["procedure_address", { procedure: dossier.procedure.name }],
      ["procedure_assembly", { procedure: dossier.procedure.address }],
      ["procedure_callers", { procedure: dossier.procedure.address }],
      ["procedure_callees", { procedure: dossier.procedure.address }],
      ["search_procedures", { pattern: dossier.procedure.name }],
      ["procedure_pseudo_code", { procedure: dossier.procedure.address }],
      ["read_function_instructions", { procedure: dossier.procedure.address }],
      [
        "search_strings",
        {
          pattern: values["expected-string"] ?? "a.b",
          mode: "literal",
          case_sensitive: true,
        },
      ],
      ["xrefs", { address: dossier.procedure.address }],
    ]) {
      const value = observe(await call(name, args));
      switch (name) {
        case "list_procedures":
        case "search_procedures":
          assert.ok(
            value.some(
              (item) =>
                item.address === dossier.procedure.address &&
                item.value === dossier.procedure.name,
            ),
            `${name} omitted the resolved procedure.`,
          );
          break;
        case "list_documents":
          assert.deepEqual(value, [target]);
          break;
        case "procedure_address":
          assert.equal(value, dossier.procedure.address);
          break;
        case "procedure_assembly":
          assert.equal(value, dossier.assembly.join("\n"));
          break;
        case "procedure_pseudo_code":
          assert.equal(value, dossier.pseudocode);
          break;
        case "procedure_callers":
        case "procedure_callees": {
          const expected =
            name === "procedure_callers" ? dossier.callers : dossier.callees;
          assert.deepEqual(
            [...value].sort(),
            expected.map((item) => item.address).sort(),
          );
          break;
        }
        case "read_function_instructions":
          assert.equal(value.procedure.address, dossier.procedure.address);
          assert.deepEqual(value.instructions, dossier.assembly);
          break;
        case "list_strings":
        case "search_strings":
          if (values["expected-string"] !== undefined)
            assert.ok(
              value.some((item) =>
                item.value.includes(values["expected-string"]),
              ),
              `${name} omitted the expected literal.`,
            );
          break;
        case "xrefs":
          if (expectedXref !== undefined)
            assert.ok(
              value.includes(expectedXref),
              "xrefs omitted the expected source address.",
            );
          else
            for (const site of await callSites(call, dossier.procedure.address))
              assert.ok(
                value.includes(site),
                "xrefs omitted a direct call site of the function entry.",
              );
          break;
      }
    }
    if (values["expected-string"] === undefined)
      report.unverified.push(
        "String inventory/search correctness: no independent expected literal supplied.",
      );
    else
      report.checks.push(
        "string inventory and literal search contain the expected literal",
      );
    if (expectedXref === undefined)
      report.unverified.push(
        "Xref correctness: no independent expected source address supplied; only inclusion of direct call sites was checked.",
      );
    else report.checks.push("xrefs contain the expected source address");
    if (values["second-procedure"] !== undefined) {
      const secondAddress = observe(
        await call("procedure_address", {
          procedure: values["second-procedure"],
        }),
      );
      assert.notEqual(secondAddress, dossier.procedure.address);
      const secondCode = observe(
        await call("procedure_pseudo_code", {
          procedure: values["second-procedure"],
        }),
      );
      assert.ok(
        !dossier.pseudocode.includes(values["second-marker"]),
        "The second marker also appears in the first function's pseudocode.",
      );
      assert.ok(
        secondCode.includes(values["second-marker"]),
        "The second function's pseudocode omitted its expected marker.",
      );
      const restored = observe(
        await call("procedure_pseudo_code", {
          procedure: dossier.procedure.address,
        }),
      );
      assert.equal(restored, dossier.pseudocode);
      report.checks.push(
        "second-function pseudocode identity and return to the original function",
      );
    } else
      report.unverified.push(
        "Function switching: no second procedure and marker supplied.",
      );
    const invalid = await client.callTool({
      name: "xrefs",
      arguments: { address: "not-an-address" },
    });
    assert.equal(invalid.isError, true);
    assert.equal(requireMcpToolError(invalid).code, "invalid_request");
    await call("close_binary", {});
    opened = false;
    report.checks.push(
      "one MCP connection, positive procedure inventory/search, contract-valid tool results, invalid input, and close",
    );
    report.checks.push(
      "CLI/MCP function identity, pseudocode, assembly, instructions, and relationship parity",
    );
  } finally {
    const completedPhase = phase;
    try {
      if (opened) await call("close_binary", {});
    } finally {
      try {
        await client.close();
      } finally {
        phase = completedPhase;
      }
    }
  }
};
/** Call sites Binary Ninja reported for the callers of an entry, read from their Evidence. */
const callSites = async (call, address) => {
  const callers = observe(
    await call("procedure_callers", { procedure: address }),
  );
  const sites = new Set();
  for (const observation of report.observations.at(-1).raw_result.observations)
    if (observation.tool === "bn_function_callers")
      for (const match of observation.result.text.matchAll(
        /^\| (0x[0-9a-f]+) \|/gimu,
      ))
        sites.add(binaryNinjaAddressSchema.parse(match[1]));
  assert.ok(callers.length === 0 || sites.size > 0);
  return sites;
};
try {
  const before = await digest();
  phase = "pre-run shared view selection";
  const selectionBefore = await activeView();
  await mcp(await cli());
  phase = "shared view selection restored";
  const selectionAfter = await activeView();
  const analysisView = report.observations[0]?.raw_result.view_before.handle;
  if (
    selectionBefore === undefined ||
    selectionBefore === null ||
    selectionBefore === analysisView
  )
    report.unverified.push(
      "Selection restore: the shared MCP selection was empty or already the target's analysis view before the run, so restoring a different selection was not exercised.",
    );
  else {
    assert.equal(selectionAfter, selectionBefore);
    report.checks.push("the previous shared MCP view selection was restored");
  }
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
