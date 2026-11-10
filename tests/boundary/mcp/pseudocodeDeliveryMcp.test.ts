import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";

import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../../../src/contracts/officialToolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { jsonObjectSchema } from "../../../src/domain/jsonValue.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { connectGhidraMcp } from "./ghidraMcpHarness.js";

const connectPseudocode = async (text: string | null) => {
  const harness = await connectGhidraMcp(
    "pseudocode-delivery",
    async (name, input) => {
      if (name !== "procedure_pseudo_code")
        throw new Error(`Unexpected provider operation ${name}`);
      expect(input).toEqual({ procedure: "fixture_main", document: null });
      return ok({
        value: text,
        limitations: ["Fixture decompiler limitation"],
      });
    },
  );
  onTestFinished(harness.close);
  return harness;
};

it("retains a complete pseudocode observation once and pages its exact text through advertised MCP contracts", async () => {
  const contract = OFFICIAL_TOOL_CONTRACTS.find(
    ({ name }) => name === "procedure_pseudo_code",
  );
  if (contract === undefined)
    throw new Error("Missing procedure_pseudo_code contract");
  const text =
    "int search(void) { return 42; }\n".repeat(3200) + "// 搜索😀\r\n";
  const { mcp, session, calls } = await connectPseudocode(text);
  const schema = await advertisedMcpToolSchemas(mcp, "procedure_pseudo_code");
  const input = { procedure: "fixture_main", detail: "summary" };
  expect(schema.ajv.validate(schema.inputSchema, input)).toBe(true);
  const reply = await mcp.callTool({
    name: "procedure_pseudo_code",
    arguments: input,
  });
  expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
  expect(
    schema.ajv.validate(schema.outputSchema, reply.structuredContent),
    JSON.stringify(schema.ajv.errors),
  ).toBe(true);
  const summary = parseEvidence(reply.structuredContent);
  const result = jsonObjectSchema.parse(summary.normalized_result);
  expect(result).toMatchObject({
    kind: "summary",
    parent_operation: "procedure_pseudo_code",
    summary: {
      selection: { procedure: "fixture_main" },
      pseudocode: {
        available: true,
        code_units: text.length,
        unit: "utf16-code-units",
      },
    },
  });
  expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(16000);
  expect(summary.raw_result).toBeNull();
  expect(reply._meta).toMatchObject({
    provenance: { untrusted_content: true },
  });
  if (typeof result.parent_evidence_id !== "string")
    throw new Error("Missing parent reference");
  const parent = session.evidenceById(result.parent_evidence_id);
  if (parent === undefined)
    throw new Error("Complete observation was not retained");
  expect(parent.normalized_result).toBe(text);
  // The normalized result is the provider observation; no raw copy repeats it.
  expect(parent.raw_result).toBeNull();
  expect(parent.parameters).toEqual({ procedure: "fixture_main" });
  expect(parent.limitations).toContain("Fixture decompiler limitation");
  const executions = [...calls];
  expect(executions).toEqual(["procedure_pseudo_code"]);
  let offset = 0;
  let restored = "";
  for (;;) {
    const page = await mcp.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
        view: { kind: "native", facet: "pseudocode", offset, limit: 20000 },
      },
    });
    expect(page.isError).not.toBe(true);
    const evidence = parseEvidence(page.structuredContent);
    const view = jsonObjectSchema.parse(evidence.normalized_result);
    expect(evidence.subject).toEqual(parent.subject);
    expect(evidence.evidence_links).toContain(parent.evidence_id);
    expect(view).toMatchObject({
      parent_operation: "procedure_pseudo_code",
      parent_evidence_id: parent.evidence_id,
      procedure_address: null,
    });
    const item = jsonObjectSchema.parse(view.item);
    if (typeof item.text !== "string") throw new Error("Missing page text");
    restored += item.text;
    const coverage = jsonObjectSchema.parse(view.coverage);
    if (coverage.next_offset === null) break;
    if (
      typeof coverage.next_offset !== "number" ||
      coverage.next_offset <= offset
    )
      throw new Error("Page did not advance");
    offset = coverage.next_offset;
  }
  expect(restored).toBe(text);
  expect(calls).toEqual(executions);
  for (const detail of [undefined, "complete"] as const) {
    const complete = await mcp.callTool({
      name: "procedure_pseudo_code",
      arguments: {
        procedure: "fixture_main",
        ...(detail === undefined ? {} : { detail }),
      },
    });
    expect(complete.isError).not.toBe(true);
    expect(
      contract.outputSchema.safeParse(complete.structuredContent).success,
    ).toBe(true);
    expect(parseEvidence(complete.structuredContent)).toEqual(parent);
  }
});

it.each([
  { procedure: "file-offset:0x10", value: "int resolved(void) { return 42; }" },
  { procedure: "0x10", value: null },
])(
  "keeps resolved parent locations in summary and portable/retained pages for $procedure",
  async ({ procedure, value }) => {
    const harness = await connectGhidraMcp(
      "pseudocode-resolved-identity",
      async (operation, input) => {
        expect(operation).toBe("procedure_pseudo_code");
        expect(input).toEqual({ procedure, document: null });
        return ok({
          value,
          limitations: [],
          selection: {
            file_offset: 0x10,
            mapped_address: "0x401010",
            procedure_address: "0x401000",
          },
        });
      },
    );
    onTestFinished(harness.close);
    const response = await harness.mcp.callTool({
      name: "procedure_pseudo_code",
      arguments: { procedure, detail: "summary" },
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const summary = parseEvidence(response.structuredContent);
    const result = jsonObjectSchema.parse(summary.normalized_result);
    if (typeof result.parent_evidence_id !== "string")
      throw new Error("Missing parent reference");
    const parent = harness.session.evidenceById(result.parent_evidence_id);
    if (parent === undefined || parent.subject === null)
      throw new Error("Missing retained artifact observation");
    const locations = [
      { kind: "artifact-path", path: parent.subject.local_path },
      ...parent.locations,
    ];
    expect(parent.parameters).toEqual({ procedure });
    expect(parent.locations).toEqual(
      expect.arrayContaining([
        { kind: "file-offset", offset: 0x10 },
        { kind: "address", address: "0x401010" },
        { kind: "address", address: "0x401000" },
      ]),
    );
    expect(summary.locations).toEqual(locations);
    for (const source of [
      { kind: "retained-evidence", evidence_id: parent.evidence_id },
      { kind: "inline", evidence: parent },
    ]) {
      const page = await harness.mcp.callTool({
        name: "inspect_analysis_view",
        arguments: {
          source,
          view: { kind: "native", facet: "pseudocode", offset: 0, limit: 12 },
        },
      });
      expect(page.isError, JSON.stringify(page)).not.toBe(true);
      const evidence = parseEvidence(page.structuredContent);
      expect(evidence.locations).toEqual(locations);
      expect(evidence.evidence_links).toEqual([parent.evidence_id]);
      expect(evidence.normalized_result).toMatchObject({
        item:
          value === null
            ? { available: false, reason: "Provider returned null" }
            : { text: value.slice(0, 12), unit: "utf16-code-units" },
      });
    }
    expect(harness.calls).toEqual(["procedure_pseudo_code"]);
  },
);

it.each(["", null])(
  "preserves the distinct scalar observation %j in a summary and page",
  async (text) => {
    const { mcp, session } = await connectPseudocode(text);
    const response = await mcp.callTool({
      name: "procedure_pseudo_code",
      arguments: { procedure: "fixture_main", detail: "summary" },
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const result = jsonObjectSchema.parse(
      parseEvidence(response.structuredContent).normalized_result,
    );
    const summary = jsonObjectSchema.parse(result.summary);
    expect(summary.pseudocode).toEqual(
      text === null
        ? { available: false, reason: "Provider returned null" }
        : { available: true, code_units: 0, unit: "utf16-code-units" },
    );
    if (typeof result.parent_evidence_id !== "string")
      throw new Error("Missing parent");
    expect(
      session.evidenceById(result.parent_evidence_id)?.normalized_result,
    ).toBe(text);
    const page = await mcp.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: {
          kind: "retained-evidence",
          evidence_id: result.parent_evidence_id,
        },
        view: { kind: "native", facet: "pseudocode", offset: 0, limit: 10 },
      },
    });
    expect(page.isError).not.toBe(true);
    expect(
      jsonObjectSchema.parse(
        parseEvidence(page.structuredContent).normalized_result,
      ).item,
    ).toEqual(
      text === null
        ? { available: false, reason: "Provider returned null" }
        : { text: "", unit: "utf16-code-units" },
    );
  },
);

it("refuses summary delivery before calling a fixed provider without retention", async () => {
  let calls = 0;
  const server = createServer(
    {
      kind: "fixed",
      analysis: {
        execute: async () => {
          calls++;
          return ok(
            createAnalysisExecution("text", {
              id: "fixture",
              name: "Fixture",
              version: "1",
            }),
          );
        },
      },
    },
    { environment: {} },
  );
  const client = new Client({ name: "pseudocode-no-retention", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({
    name: "procedure_pseudo_code",
    arguments: { procedure: "main", detail: "summary" },
  });
  expect(parseMcpToolError(result).error.message).toContain(
    "does not retain Evidence",
  );
  expect(calls).toBe(0);
});

it("keeps transport-overflow recovery usable for the original pseudocode observation", async () => {
  // Exceeds the default 10 MiB stdio response budget on its own.
  const text = "x".repeat(11 * 1024 * 1024);
  const { mcp, session, calls } = await connectPseudocode(text);
  const response = await mcp.callTool({
    name: "procedure_pseudo_code",
    arguments: { procedure: "fixture_main" },
  });
  const failure = parseMcpToolError(response).error;
  expect(failure.code).toBe("resource_constraint");
  const limits = jsonObjectSchema.parse(
    jsonObjectSchema.parse(failure.details).reported_limits,
  );
  const continuation = jsonObjectSchema.parse(limits.continuation);
  expect(continuation.name).toBe("inspect_analysis_view");
  const page = await mcp.callTool({
    name: "inspect_analysis_view",
    arguments: jsonObjectSchema.parse(continuation.arguments),
  });
  expect(page.isError).not.toBe(true);
  const result = jsonObjectSchema.parse(
    parseEvidence(page.structuredContent).normalized_result,
  );
  expect(result).toMatchObject({
    item: { text: "x".repeat(64) },
    coverage: { total: text.length, next_offset: 64 },
  });
  if (typeof result.parent_evidence_id !== "string")
    throw new Error("Missing parent");
  expect(
    session.evidenceById(result.parent_evidence_id)?.normalized_result,
  ).toBe(text);
  expect(calls).toEqual(["procedure_pseudo_code"]);
  await mcp.ping();
});
