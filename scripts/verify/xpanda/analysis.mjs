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
const sampleFrom = async (candidates) => {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next documented sample location.
    }
  }
  return undefined;
};
const abc = resolve(
  (await sampleFrom(
    process.env.REA_XPANDA_TEST_ABC === undefined
      ? [
          join(xpandaRoot, "test/resources/md5.abc"),
          join(xpandaRoot, "packages/xpanda-core/test/resources/md5.abc"),
        ]
      : [process.env.REA_XPANDA_TEST_ABC],
  )) ?? "",
);
await access(abc);
const hap = await sampleFrom(
  process.env.REA_XPANDA_TEST_HAP === undefined
    ? [
        join(xpandaRoot, "test_app/dist/target-probe.hap"),
        join(xpandaRoot, "packages/xpanda-core/test/resources/zhihupp0.59.hap"),
      ]
    : [process.env.REA_XPANDA_TEST_HAP],
);

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

  if (target !== undefined) {
    const metadata = harmonyAbcResultSchemas.inspect_harmony_abc_class.parse(
      parseEvidence(
        await run([
          "inspect-harmony-abc-class",
          abc,
          target.name,
          "--format",
          "json",
        ]),
      ).normalized_result,
    );
    assert.equal(metadata.class_name, target.name);
    console.log(
      `PASS CLI inspect_harmony_abc_class ${metadata.class_name} methods=${String(metadata.methods.length)} fields=${String(metadata.fields.length)}`,
    );

    const method = metadata.methods.find(
      ({ name, has_code }) =>
        has_code && !name.startsWith("#") && name !== "func_main_0",
    );
    let callGraphMethod;
    if (method !== undefined) {
      callGraphMethod = method.name;
      const decompiledMethod =
        harmonyAbcResultSchemas.decompile_harmony_abc_method.parse(
          parseEvidence(
            await run([
              "decompile-harmony-abc-method",
              abc,
              target.name,
              method.name,
              "--format",
              "json",
            ]),
          ).normalized_result,
        );
      assert.equal(decompiledMethod.method_name, method.name);
      console.log(
        `PASS CLI decompile_harmony_abc_method ${decompiledMethod.method_name} chars=${String(decompiledMethod.characters)} degraded=${String(decompiledMethod.degraded)}`,
      );
    }

    const symbols = harmonyAbcResultSchemas.search_harmony_abc_symbols.parse(
      parseEvidence(
        await run([
          "search-harmony-abc-symbols",
          abc,
          "--query",
          "",
          "--kind",
          "class",
          "--limit",
          "5",
          "--format",
          "json",
        ]),
      ).normalized_result,
    );
    assert.ok(
      symbols.returned >= 1,
      "the sample must list at least one class symbol",
    );
    console.log(
      `PASS CLI search_harmony_abc_symbols returned=${String(symbols.returned)}/${String(symbols.total)}`,
    );

    const code = harmonyAbcResultSchemas.search_harmony_abc_code.parse(
      parseEvidence(
        await run([
          "search-harmony-abc-code",
          abc,
          "return",
          "--limit",
          "5",
          "--format",
          "json",
        ]),
      ).normalized_result,
    );
    assert.ok(
      code.scanned_classes >= 1,
      "code search must scan at least one class",
    );
    console.log(
      `PASS CLI search_harmony_abc_code scanned=${String(code.scanned_classes)} returned=${String(code.returned)} truncated=${String(code.truncated)}`,
    );

    const xrefs = harmonyAbcResultSchemas.trace_harmony_abc_references.parse(
      parseEvidence(
        await run([
          "trace-harmony-abc-references",
          abc,
          "--target-type",
          "class",
          "--target",
          target.name,
          "--format",
          "json",
        ]),
      ).normalized_result,
    );
    assert.ok(
      xrefs.xref_count >= 1,
      "the sample must carry a cross-reference index",
    );
    console.log(
      `PASS CLI trace_harmony_abc_references xrefs=${String(xrefs.xref_count)} returned=${String(xrefs.returned)}`,
    );

    if (callGraphMethod !== undefined) {
      const graph = harmonyAbcResultSchemas.build_harmony_abc_call_graph.parse(
        parseEvidence(
          await run([
            "build-harmony-abc-call-graph",
            abc,
            target.name,
            callGraphMethod,
            "--format",
            "json",
          ]),
        ).normalized_result,
      );
      assert.ok(graph.node_count >= 1, "the call graph must contain its root");
      console.log(
        `PASS CLI build_harmony_abc_call_graph nodes=${String(graph.node_count)} edges=${String(graph.edge_count)} truncated=${String(graph.truncated)}`,
      );
    }
  }

  if (hap !== undefined) {
    const packageEntry = harmonyAbcResultSchemas.inspect_harmony_hap_abc.parse(
      parseEvidence(
        await run(["inspect-harmony-hap-abc", hap, "--format", "json"]),
      ).normalized_result,
    );
    assert.ok(packageEntry.entry.length > 0);
    console.log(
      `PASS CLI inspect_harmony_hap_abc ${packageEntry.entry} runtime=${packageEntry.runtime} classes=${String(packageEntry.class_count)}`,
    );
    const resources =
      harmonyAbcResultSchemas.inspect_harmony_hap_resources.parse(
        parseEvidence(
          await run([
            "inspect-harmony-hap-resources",
            hap,
            "--limit",
            "5",
            "--format",
            "json",
          ]),
        ).normalized_result,
      );
    assert.ok(resources.matched >= 1);
    console.log(
      `PASS CLI inspect_harmony_hap_resources format=${resources.format} matched=${String(resources.matched)}/${String(resources.total)}`,
    );
  } else {
    console.log(
      "SKIP HAP checks: no .hap sample found; set REA_XPANDA_TEST_HAP",
    );
  }

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
      "inspect_harmony_abc_class",
      "decompile_harmony_abc_method",
      "search_harmony_abc_symbols",
      "search_harmony_abc_code",
      "trace_harmony_abc_references",
      "build_harmony_abc_call_graph",
      "inspect_harmony_hap_abc",
      "inspect_harmony_hap_resources",
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
    const mcpSymbols = await client.callTool(
      {
        name: "search_harmony_abc_symbols",
        arguments: { path: abc, query: "", kind: "class", limit: 5 },
      },
      { timeout: 300_000 },
    );
    assert.notEqual(mcpSymbols.isError, true, JSON.stringify(mcpSymbols));
    const mcpSymbolEvidence = parseEvidence(mcpSymbols.structuredContent);
    const mcpSymbolResult =
      harmonyAbcResultSchemas.search_harmony_abc_symbols.parse(
        mcpSymbolEvidence.normalized_result,
      );
    assert.ok(mcpSymbolResult.returned >= 1);
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
