#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { PrivateRuntimeRoot } from "../dist/process/PrivateRuntimeRoot.js";
import { parseEvidence } from "../dist/domain/evidence.js";
import {
  mcpTextValue,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";

const directory = process.env.REA_WABT_BIN_DIRECTORY;
if (!isAbsolute(directory ?? "")) {
  if (process.argv.includes("--require-tools"))
    throw new Error(
      "Supply absolute REA_WABT_BIN_DIRECTORY containing WABT 1.0.42 tools.",
    );
  console.log(
    JSON.stringify({
      status: "skipped",
      reason:
        "WABT real-tool lane requires caller-supplied REA_WABT_BIN_DIRECTORY; no tools installed.",
    }),
  );
  process.exit(0);
}
const entrypoint =
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
  fileURLToPath(new URL("./rea.mjs", import.meta.url));
const execute = promisify(execFile);
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === "string"),
);
const toolPath = (tool) =>
  join(directory, `${tool}${process.platform === "win32" ? ".exe" : ""}`);
const tool = (name, args, cwd) =>
  execute(toolPath(name), args, {
    cwd,
    env: environment,
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const run = createVerifierRun();
const root = await PrivateRuntimeRoot.create({ prefix: "rea-wabt-verifier-" });
const client = new Client({ name: "wabt-artifact-verifier", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env: { ...environment, TMPDIR: root.path, TMP: root.path, TEMP: root.path },
  stderr: "pipe",
});
let cases = 0;
const failures = [];
try {
  for (const name of ["wat2wasm", "wasm-validate", "wasm-objdump", "wasm2wat"])
    assert.equal(
      (await tool(name, ["--version"], root.path)).stdout.trim(),
      "1.0.42",
    );
  await client.connect(transport);
  const advertised = (await client.listTools()).tools.find(
    ({ name }) => name === "inspect_wasm_artifact",
  );
  assert.ok(advertised?.outputSchema, "WASM tool must advertise output schema");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  assert.ok(ajv.validateSchema(advertised.inputSchema));
  assert.ok(ajv.validateSchema(advertised.outputSchema));
  const inspectCli = async (input) => {
    try {
      return JSON.parse(
        (
          await execute(
            process.execPath,
            [
              entrypoint,
              "inspect-wasm-artifact",
              input.path,
              ...input.glue_paths.flatMap((path) => ["--glue_paths", path]),
              ...input.candidate_paths.flatMap((path) => [
                "--candidate_paths",
                path,
              ]),
              "--format",
              "json",
            ],
            {
              env: {
                ...environment,
                TMPDIR: root.path,
                TMP: root.path,
                TEMP: root.path,
              },
              timeout: 120_000,
              maxBuffer: 64 * 1024 * 1024,
            },
          )
        ).stdout,
      );
    } catch (cause) {
      if (typeof cause.code === "number" && typeof cause.stdout === "string")
        return JSON.parse(cause.stdout);
      throw cause;
    }
  };
  const sources = [
    await readFile(
      new URL("../tests/fixtures/wasm/module.wat", import.meta.url),
      "utf8",
    ),
    "(module)\n",
    '(module (import "env.with.dot" "field.with.dot" (global i32)) (import "env" "table" (table 1 funcref)) (memory (export "memory") 1) (export "g" (global 0)) (export "t" (table 0)) (func (export "name\\0aline") (result i32) i32.const 42))\n',
  ];
  for (const [index, source] of sources.entries()) {
    const fixtureRoot = join(root.path, `fixture-${index}`);
    await mkdir(fixtureRoot);
    const path = join(fixtureRoot, "module.wasm");
    await writeFile(join(fixtureRoot, "source.wat"), source);
    await tool(
      "wat2wasm",
      ["--enable-all", "source.wat", "-o", "module.wasm"],
      fixtureRoot,
    );
    await tool("wasm-validate", ["--enable-all", "module.wasm"], fixtureRoot);
    const original = await readFile(path);
    const dump = (
      await tool("wasm-objdump", ["-h", "-x", "module.wasm"], fixtureRoot)
    ).stdout;
    const wat = (
      await tool("wasm2wat", ["--enable-all", "module.wasm"], fixtureRoot)
    ).stdout;
    await writeFile(join(fixtureRoot, "decoded.wat"), wat);
    await tool(
      "wat2wasm",
      ["--enable-all", "decoded.wat", "-o", "roundtrip.wasm"],
      fixtureRoot,
    );
    await tool(
      "wasm-validate",
      ["--enable-all", "roundtrip.wasm"],
      fixtureRoot,
    );
    const candidateRoot = join(fixtureRoot, "other");
    await mkdir(candidateRoot);
    const candidate = join(candidateRoot, "module.wasm");
    await writeFile(join(candidateRoot, "source.wat"), "(module (memory 2))");
    await tool("wat2wasm", ["source.wat", "-o", "module.wasm"], candidateRoot);
    const glue = join(fixtureRoot, "glue.js");
    await writeFile(
      glue,
      'fetch("./module.wasm"); new URL("https://example.invalid/module.wasm?version=1", import.meta.url);',
    );
    const input = { path, glue_paths: [glue], candidate_paths: [candidate] };
    assert.ok(ajv.validate(advertised.inputSchema, input));
    const cliValue = await inspectCli(input);
    assert.equal(cliValue.category, undefined, JSON.stringify(cliValue));
    const cli = parseEvidence(cliValue);
    const reply = await client.callTool({
      name: "inspect_wasm_artifact",
      arguments: input,
    });
    assert.notEqual(reply.isError, true, mcpTextValue(reply));
    assert.ok(
      ajv.validate(advertised.outputSchema, reply.structuredContent),
      JSON.stringify(ajv.errors),
    );
    const mcp = parseEvidence(reply.structuredContent);
    assert.equal(cli.evidence_id, mcp.evidence_id);
    assert.deepEqual(cli, mcp);
    const report = mcp.normalized_result;
    assert.equal(report.artifact.sha256, sha256(original));
    assert.equal(report.artifact.bytes, original.length);
    assert.equal(report.wat.text, wat);
    assert.equal(report.wat.sha256, sha256(wat));
    assert.equal(
      report.headers,
      dump.slice(0, dump.indexOf("Section Details:\n")),
    );
    assert.equal(
      report.details,
      `module.wasm:\tfile format wasm 0x1\n\n${dump.slice(dump.indexOf("Section Details:\n"))}`,
    );
    assert.equal(report.glue[0].artifact.sha256, sha256(await readFile(glue)));
    assert.deepEqual(
      report.glue[0].references.map(({ candidate_paths }) => candidate_paths),
      [[path], [path, candidate]],
    );
    assert.notEqual(report.candidates[0].sha256, report.candidates[1].sha256);
    for (const command of report.tool_profile.commands)
      assert.equal(command.sha256, sha256(await readFile(command.path)));
    if (index === 0) {
      assert.ok(
        report.sections.some(
          ({ kind, description }) =>
            kind === "Custom" && description === '"test"',
        ),
      );
      assert.ok(report.wat.text.includes('(@custom "test" "payload")'));
      assert.equal(
        sha256(await readFile(join(fixtureRoot, "roundtrip.wasm"))),
        sha256(original),
      );
    }
    const bundleReply = await client.callTool({
      name: "get_evidence_bundle",
      arguments: {},
    });
    assert.notEqual(bundleReply.isError, true, mcpTextValue(bundleReply));
    const bundle = JSON.parse(mcpTextValue(bundleReply)).result;
    const retained = bundle.records.find(
      ({ evidence_id }) => evidence_id === mcp.evidence_id,
    );
    assert.deepEqual(parseEvidence(retained), mcp);
    assert.deepEqual(await readFile(path), original);
    cases += 2;
    for (const [label, invalidBytes] of [
      ["truncated", original.subarray(0, 7)],
      ["invalid", Buffer.from("not a wasm module")],
    ]) {
      const invalidPath = join(fixtureRoot, `${label}.wasm`);
      await writeFile(invalidPath, invalidBytes);
      const invalidInput = {
        path: invalidPath,
        glue_paths: [],
        candidate_paths: [],
      };
      const cliError = await inspectCli(invalidInput);
      assert.equal(
        cliError.category,
        "invalid_input",
        JSON.stringify(cliError),
      );
      const error = requireMcpToolError(
        await client.callTool({
          name: "inspect_wasm_artifact",
          arguments: invalidInput,
        }),
      );
      assert.equal(error.category, "invalid_input");
      const failed = parseEvidence(error.details.partial_observation);
      assert.equal(failed.subject.digest.sha256, sha256(invalidBytes));
      assert.equal(
        failed.normalized_result.validation,
        "rejected-by-selected-profile",
      );
      assert.equal(
        cliError.details.partial_observation.evidence_id,
        failed.evidence_id,
      );
      assert.ok(
        error.details?.captured_output?.stderr?.length > 0,
        JSON.stringify(error),
      );
      assert.deepEqual(await readFile(invalidPath), invalidBytes);
      cases += 2;
    }
  }
} catch (cause) {
  failures.push(cause);
}
try {
  await client.close();
} catch (cause) {
  failures.push(cause);
}
try {
  await transport.close();
} catch (cause) {
  failures.push(cause);
}
try {
  assert.ok(
    !(await readdir(root.path)).some((name) => name.startsWith("rea-wabt-")),
    "Provider workspace leaked",
  );
  await root.close();
} catch (cause) {
  failures.push(cause);
}
if (failures.length > 0)
  throw new AggregateError(failures, "WABT real-tool verification failed.");
console.log(
  JSON.stringify(
    {
      status: "passed",
      cases,
      tool_profile: "wabt@1.0.42",
      entrypoint,
      verifier: await completeVerifierRun(run),
    },
    null,
    2,
  ),
);
