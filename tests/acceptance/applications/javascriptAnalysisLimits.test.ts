import type { Client } from "@modelcontextprotocol/client";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const cases = [
  {
    name: "both limits",
    args: ["--max-heap-mb", "128", "--analysis-timeout-ms", "30000"],
    controls: { max_heap_mb: 128, analysis_timeout_ms: 30000 },
  },
  {
    name: "heap limit alone",
    args: ["--max-heap-mb", "256"],
    controls: { max_heap_mb: 256 },
  },
  {
    name: "timeout alone",
    args: ["--analysis-timeout-ms", "40000"],
    controls: { analysis_timeout_ms: 40000 },
  },
  {
    name: "omitted limits",
    args: [],
    controls: {},
  },
];

cliTest.for(cases)(
  "preserves $name in CLI Evidence without adding ambient defaults",
  async ({ args, controls }, { cli }) => {
    const root = await createTestTempDirectory("rea-js-limit-provenance-");
    await writeFile(join(root, "main.js"), "export const observed = 7;\n");
    const response = await cli.run({
      arguments: [
        "analyze-javascript-application",
        root,
        ...args,
        "--format",
        "json",
      ],
      environment: { NODE_OPTIONS: "--max-old-space-size=512" },
    });
    expect(response.exitCode, response.stdout + response.stderr).toBe(0);
    const evidence = parseEvidence(response.json);
    expect(evidence.parameters).toEqual({
      format: "auto",
      integrity_policy: "fail",
      ...controls,
    });
  },
);

it("preserves MCP analysis limits in retained Evidence and an exported bundle round trip", async () => {
  const root = await createTestTempDirectory("rea-js-limit-mcp-");
  await writeFile(join(root, "main.js"), "export const observed = 7;\n");
  const bundleRoot = await createTestTempDirectory("rea-js-limit-bundle-");
  const path = join(bundleRoot, "evidence.json");
  const { client } = await connectLocalToolsMcp({
    NODE_OPTIONS: "--max-old-space-size=512",
  });
  const expected = new Map<string, unknown>();
  for (const { controls } of cases) {
    const response = await client.callTool({
      name: "analyze_javascript_application",
      arguments: { input_path: root, ...controls, detail: "summary" },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const { parent_evidence_id } = z
      .object({
        normalized_result: z.object({ parent_evidence_id: z.string() }),
      })
      .parse(response.structuredContent).normalized_result;
    expected.set(parent_evidence_id, {
      format: "auto",
      integrity_policy: "fail",
      ...controls,
    });
  }
  expect(expected.size).toBe(cases.length);
  const retained = await getBundle(client);
  for (const [evidence_id, parameters] of expected)
    expect(
      retained.records.find((record) => record.evidence_id === evidence_id)
        ?.parameters,
    ).toEqual(parameters);
  const exported = await client.callTool({
    name: "export_evidence_bundle",
    arguments: { path },
  });
  expect(exported.isError).not.toBe(true);
  expect(parseEvidenceBundle(JSON.parse(await readFile(path, "utf8")))).toEqual(
    retained,
  );
  const closed = await client.callTool({
    name: "close_binary",
    arguments: {},
  });
  expect(closed.isError).not.toBe(true);
  expect((await getBundle(client)).records).toEqual([]);
  const imported = await client.callTool({
    name: "import_evidence_bundle",
    arguments: { path },
  });
  expect(imported.isError, JSON.stringify(imported.content)).not.toBe(true);
  expect(await getBundle(client)).toEqual(retained);
}, 60_000);

it("retains caller limits in partial Evidence after an actual analysis timeout", async () => {
  const root = await createTestTempDirectory("rea-js-limit-timeout-");
  await writeFile(join(root, "main.js"), "export const observed = 7;\n");
  const { client } = await connectLocalToolsMcp({
    NODE_OPTIONS: "--max-old-space-size=512",
  });
  const response = await client.callTool({
    name: "analyze_javascript_application",
    arguments: {
      input_path: root,
      max_heap_mb: 128,
      analysis_timeout_ms: 1,
    },
  });
  expect(parseMcpToolError(response)).toMatchObject({
    error: { code: "provider_timeout" },
  });
  const bundle = await getBundle(client);
  const partial = bundle.records.find(
    (record) => record.operation === "analyze_javascript_application",
  );
  expect(partial?.parameters).toEqual({
    format: "auto",
    integrity_policy: "fail",
    max_heap_mb: 128,
    analysis_timeout_ms: 1,
  });
  await client.ping();
}, 30_000);

async function getBundle(client: Client) {
  const response = await client.callTool({
    name: "get_evidence_bundle",
    arguments: { detail: "complete" },
  });
  expect(response.isError).not.toBe(true);
  return parseEvidenceBundle(
    z.object({ result: z.unknown() }).parse(response.structuredContent).result,
  );
}
