import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import {
  VerifierFixture,
  withVerifierFixture,
} from "../../lib/verifier-fixture.mjs";
import { parseEvidence } from "../../../dist/domain/evidence.js";
import { harmonyAbcResultSchemas } from "../../../dist/domain/harmony/harmonyAbcAnalysis.js";

/**
 * Real xpanda lane: the compiled CLI and the SDK-connected stdio MCP server
 * run against a caller-supplied xpanda checkout (bring your own; REA never
 * installs it). The default sample is the checkout's own md5.abc fixture;
 * set REA_XPANDA_TEST_ABC to verify another .abc file.
 */

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const xpandaRoot = process.env.REA_XPANDA_ROOT;
assert.ok(
  xpandaRoot !== undefined && xpandaRoot.startsWith("/"),
  "verify:xpanda requires REA_XPANDA_ROOT to name the caller-supplied xpanda checkout by absolute path (bring your own)",
);
const abc = resolve(
  process.env.REA_XPANDA_TEST_ABC ?? join(xpandaRoot, "test/resources/md5.abc"),
);
await access(abc);

const entrypoint =
  process.env.REA_XPANDA_ENTRYPOINT ?? resolve(repository, "scripts/rea.mjs");
const environment = { ...process.env, REA_XPANDA_ROOT: xpandaRoot };
const execute = promisify(execFile);
const run = async (arguments_) => {
  const response = await execute(
    process.execPath,
    [entrypoint, ...arguments_],
    {
      cwd: repository,
      env: environment,
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return JSON.parse(response.stdout);
};
const fixture = await VerifierFixture.open({ prefix: "rea-xpanda-verify-" });
const workspace = fixture.path;

await withVerifierFixture(fixture, async () => {
  const inspection = parseEvidence(
    await run(["inspect-harmony-abc", abc, "--format", "json"]),
  );
  assert.equal(inspection.operation, "inspect_harmony_abc");
  assert.equal(inspection.subject?.identity.kind, "file");
  assert.equal(
    inspection.subject?.identity.kind === "file"
      ? inspection.subject.identity.format
      : undefined,
    "abc",
  );
  assert.equal(inspection.provider.id, "xpanda");
  const header = harmonyAbcResultSchemas.inspect_harmony_abc.parse(
    inspection.normalized_result,
  );
  assert.ok(header.class_count >= 1, "the sample must contain classes");
  assert.match(header.bytecode_version, /^\d+\.\d+\.\d+\.\d+$/u);
  console.log(
    `PASS CLI inspect_harmony_abc ${String(header.class_count)} classes, bytecode ${header.bytecode_version}, xpanda ${inspection.provider.version}`,
  );

  const listing = parseEvidence(
    await run([
      "list-harmony-abc-classes",
      abc,
      "--limit",
      "500",
      "--format",
      "json",
    ]),
  );
  const classes = harmonyAbcResultSchemas.list_harmony_abc_classes.parse(
    listing.normalized_result,
  );
  assert.equal(classes.total_classes, header.class_count);
  assert.ok(classes.classes.length >= 1);
  const target = classes.classes.find(({ methods }) => methods > 0);
  console.log(
    `PASS CLI list_harmony_abc_classes ${String(classes.returned)}/${String(classes.total_classes)} classes`,
  );

  if (target !== undefined) {
    const decompiled = parseEvidence(
      await run([
        "decompile-harmony-abc-class",
        abc,
        target.name,
        "--format",
        "json",
      ]),
    );
    const decompilation =
      harmonyAbcResultSchemas.decompile_harmony_abc_class.parse(
        decompiled.normalized_result,
      );
    assert.equal(decompilation.truncated, false);
    assert.ok(
      decompilation.empty_result || decompilation.content.length > 0,
      "a class with methods must decompile or report why it is empty",
    );
    console.log(
      `PASS CLI decompile_harmony_abc_class ${target.name} (degraded=${String(decompilation.degraded)})`,
    );

    const disassembled = parseEvidence(
      await run([
        "disassemble-harmony-abc-method",
        abc,
        target.name,
        "--format",
        "json",
      ]),
    );
    const disassembly =
      harmonyAbcResultSchemas.disassemble_harmony_abc_method.parse(
        disassembled.normalized_result,
      );
    assert.match(disassembly.text, /^method: /u);
    assert.ok(disassembly.blocks >= 1);
    console.log(
      `PASS CLI disassemble_harmony_abc_method ${disassembly.method_name} (${String(disassembly.blocks)} blocks)`,
    );
  } else {
    console.log(
      "SKIP CLI decompile/disassemble: the sample has no class with methods",
    );
  }

  const strings = parseEvidence(
    await run([
      "search-harmony-abc-strings",
      abc,
      "a",
      "--limit",
      "5",
      "--format",
      "json",
    ]),
  );
  const matches = harmonyAbcResultSchemas.search_harmony_abc_strings.parse(
    strings.normalized_result,
  );
  assert.ok(matches.pool_size >= 1, "the sample string pool must be populated");
  console.log(
    `PASS CLI search_harmony_abc_strings pool=${String(matches.pool_size)} matched=${String(matches.matched)}`,
  );

  const output = join(workspace, "decompiled");
  const exported = parseEvidence(
    await run(["decompile-harmony-abc", abc, output, "--format", "json"]),
  );
  const export_ = harmonyAbcResultSchemas.decompile_harmony_abc.parse(
    exported.normalized_result,
  );
  assert.equal(export_.output_directory, output);
  assert.equal(export_.written + export_.skipped + export_.failed > 0, true);
  await access(output);
  console.log(
    `PASS CLI decompile_harmony_abc written=${String(export_.written)} skipped=${String(export_.skipped)} failed=${String(export_.failed)} coverage=${export_.coverage}`,
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    cwd: repository,
    env: environment,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "rea-real-xpanda-verifier", version: "1" });
  try {
    await client.connect(transport, { timeout: 30_000 });
    const tools = await client.listTools();
    for (const name of [
      "inspect_harmony_abc",
      "list_harmony_abc_classes",
      "decompile_harmony_abc_class",
      "decompile_harmony_abc",
      "disassemble_harmony_abc_method",
      "search_harmony_abc_strings",
    ])
      assert.ok(
        tools.tools.some((tool) => tool.name === name),
        `MCP must advertise ${name}`,
      );
    const inspected = await client.callTool(
      { name: "inspect_harmony_abc", arguments: { path: abc } },
      { timeout: 300_000 },
    );
    assert.notEqual(inspected.isError, true, JSON.stringify(inspected));
    const mcpInspection = parseEvidence(inspected.structuredContent);
    assert.deepEqual(
      mcpInspection.normalized_result,
      inspection.normalized_result,
      "MCP and CLI must report identical header facts",
    );
    const mcpListing = await client.callTool(
      {
        name: "list_harmony_abc_classes",
        arguments: { path: abc, limit: 500 },
      },
      { timeout: 300_000 },
    );
    assert.notEqual(mcpListing.isError, true, JSON.stringify(mcpListing));
    const mcpClasses = parseEvidence(mcpListing.structuredContent);
    assert.deepEqual(
      mcpClasses.normalized_result,
      listing.normalized_result,
      "MCP and CLI must report identical class inventories",
    );
    const rejected = await client.callTool(
      {
        name: "decompile_harmony_abc_class",
        arguments: { path: abc, class_name: "com.rea.absent.Class" },
      },
      { timeout: 300_000 },
    );
    assert.equal(rejected.isError, true, "absent classes must fail typed");
    console.log("PASS MCP/CLI parity and absent-class error");
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    assert.equal(
      stderr.includes("Unhandled") || stderr.includes("uncaught"),
      false,
      `MCP server stderr reported a failure: ${stderr.slice(0, 2000)}`,
    );
  }
  console.log("PASS verify:xpanda");
});
