import { McpServer } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { z } from "zod";
import { createServer } from "../../../src/server/createServer.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

const malformedRead = { address: 123, length: 0, document: false };
const readIssues = [
  { path: ["address"], reason: "invalid_type", expected: "string" },
  { path: ["length"], reason: "out_of_range", minimum: 1 },
  { path: ["document"], reason: "invalid_type", expected: "string" },
];

mcpTest(
  "keeps concurrent SDK validation issues attached to their own tool call",
  async ({ mcp }) => {
    let calls = 0;
    const server = createServer({
      kind: "fixed",
      analysis: {
        execute: () => {
          calls += 1;
          return Promise.resolve(observed(null));
        },
      },
    });
    const client = await mcp.connect(server);
    const [read, search, missing] = await Promise.all([
      client.callTool({
        name: "read_bytes",
        arguments: malformedRead,
      }),
      client.callTool({
        name: "search_bytes",
        arguments: { pattern: 123, limit: 0, cursor: 23 },
      }),
      client.callTool({ name: "read_bytes", arguments: {} }),
    ]);
    expect(parseMcpToolError(read)).toMatchObject({
      error: {
        code: "invalid_request",
        details: {
          issues: readIssues,
        },
      },
    });
    expect(parseMcpToolError(search)).toMatchObject({
      error: {
        code: "invalid_request",
        details: {
          issues: [
            { path: ["pattern"], reason: "invalid_type", expected: "string" },
            { path: ["limit"], reason: "out_of_range", minimum: 1 },
            { path: ["cursor"], reason: "invalid_type", expected: "string" },
          ],
        },
      },
    });
    expect(parseMcpToolError(missing)).toMatchObject({
      error: {
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["address"],
              reason: "missing_argument",
              expected: "string",
            },
          ],
        },
      },
    });
    expect(calls).toBe(0);
    await expect(client.ping()).resolves.toBeDefined();
  },
);

it("preserves field diagnostics over production stdio and keeps serving", async () => {
  const { call, client } = await connectLocalToolsMcp();
  const result = await call("read_bytes", malformedRead);
  expect(parseMcpToolError(result)).toMatchObject({
    error: {
      code: "invalid_request",
      recovery: { kind: "inspect_input_contract", operation: "read_bytes" },
      details: {
        issues: readIssues,
      },
    },
  });
  await expect(client.ping()).resolves.toBeDefined();
});

mcpTest(
  "retains mixed SDK field diagnostics without repeating custom guidance",
  async ({ mcp }) => {
    const info = { name: "custom-issues", version: "1" };
    const server = new EvidenceMcpServer(
      info,
      { capabilities: {} },
      undefined,
      createToolResultDelivery(4096),
    );
    const inputSchema = z.strictObject({
      first: z.string().regex(/^a$/u, "first correction"),
      second: z.string().regex(/^b$/u, "second correction"),
      count: z.number(),
    });
    server.registerTool("custom_issues", { inputSchema }, async () => ({
      content: [{ type: "text", text: "unexpected dispatch" }],
    }));
    const client = await mcp.connect(server);
    const argumentsValue = {
      first: "wrong",
      second: "wrong",
      count: "wrong",
      extra: true,
    };
    const parsed = inputSchema.safeParse(argumentsValue);
    if (parsed.success) throw new Error("expected invalid input");
    const countIssue = parsed.error.issues.find(
      (issue) => issue.path[0] === "count",
    );
    if (countIssue === undefined) throw new Error("missing count issue");
    const unknownIssue = parsed.error.issues.find(
      (issue) => issue.code === "unrecognized_keys",
    );
    if (unknownIssue === undefined)
      throw new Error("missing unknown-key issue");
    const result = await client.callTool({
      name: "custom_issues",
      arguments: argumentsValue,
    });
    const error = parseMcpToolError(result).error;
    expect(error.details).toMatchObject({
      issues: [
        {
          path: ["first"],
          reason: "invalid_format",
          message: "first correction",
        },
        {
          path: ["second"],
          reason: "invalid_format",
          message: "second correction",
        },
        {
          path: ["count"],
          reason: "invalid_type",
          expected: "number",
          message: countIssue.message,
        },
        { path: ["extra"], reason: "unknown_argument" },
      ],
    });
    const text = JSON.stringify(error);
    expect(text.split("first correction")).toHaveLength(2);
    expect(text.split("second correction")).toHaveLength(2);
    expect(error.message.split(unknownIssue.message)).toHaveLength(2);
  },
);

mcpTest(
  "keeps same-path union and independent issues attributed to their producers",
  async ({ mcp }) => {
    const info = { name: "issue-producer", version: "1" };
    const server = new EvidenceMcpServer(
      info,
      { capabilities: {} },
      undefined,
      createToolResultDelivery(4096),
    );
    const inputSchema = z.intersection(
      z.object({
        a: z.union([z.object({ x: z.string() }), z.object({ x: z.number() })]),
      }),
      z.object({ a: z.object({ x: z.array(z.string()) }) }),
    );
    server.registerTool("overlapping_issues", { inputSchema }, async () => ({
      content: [{ type: "text", text: "unexpected dispatch" }],
    }));
    const client = await mcp.connect(server);
    const input = { a: { x: false } };
    const parsed = inputSchema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");
    const rawArrayIssue = parsed.error.issues.find(
      (issue) => issue.code === "invalid_type",
    );
    if (rawArrayIssue === undefined) throw new Error("missing array issue");
    const result = await client.callTool({
      name: "overlapping_issues",
      arguments: input,
    });
    const error = parseMcpToolError(result).error;
    const issues = error.details?.issues;
    expect(issues).toHaveLength(3);
    expect(issues).toEqual(
      expect.arrayContaining([
        {
          path: ["a", "x"],
          reason: "invalid_type",
          expected: "array",
          message: rawArrayIssue.message,
        },
        { path: ["a", "x"], reason: "invalid_type", expected: "string" },
        { path: ["a", "x"], reason: "invalid_type", expected: "number" },
      ]),
    );
  },
);

mcpTest(
  "discloses when bounded projection cannot retain raw SDK field details",
  async ({ mcp }) => {
    const info = { name: "bounded-issues", version: "1" };
    const server = new EvidenceMcpServer(
      info,
      { capabilities: {} },
      undefined,
      createToolResultDelivery(4096),
    );
    const sdkServer = new McpServer(info);
    const branches = Array.from({ length: 256 }, (_, index) =>
      z.object({ [`field_${String(index)}`]: z.string() }),
    );
    const cases = [
      {
        name: "bounded_issues",
        inputSchema: z.object({ value: z.union(branches) }),
        arguments: { value: {} },
      },
      {
        name: "long_key",
        inputSchema: z.strictObject({}),
        arguments: { [`key_${"x".repeat(1600)}`]: true },
      },
    ];
    const unexpectedDispatch = () => {
      throw new Error("Invalid input reached tool execution");
    };
    for (const { name, inputSchema } of cases) {
      server.registerTool(name, { inputSchema }, unexpectedDispatch);
      sdkServer.registerTool(name, { inputSchema }, unexpectedDispatch);
    }
    const client = await mcp.connect(server);
    const sdkClient = await mcp.connect(sdkServer);

    for (const { name, arguments: input } of cases) {
      const [result, original] = await Promise.all([
        client.callTool({ name, arguments: input }),
        sdkClient.callTool({ name, arguments: input }),
      ]);
      const sdkText = original.content.find(
        (item) => item.type === "text",
      )?.text;
      const prefix = `Input validation error: Invalid arguments for tool ${name}: `;
      if (sdkText === undefined || !sdkText.startsWith(prefix))
        throw new Error(`Expected the SDK's argument diagnostic for ${name}`);
      const diagnostic = sdkText.slice(prefix.length);
      expect(diagnostic, name).not.toBe("");

      const { error } = parseMcpToolError(result);
      expect(error, name).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: [],
              reason: "invalid_value",
              message: diagnostic,
              observed: { field_details: "omitted" },
            },
          ],
        },
      });
      expect(error.message, name).not.toContain(diagnostic);
    }
    await expect(client.ping()).resolves.toBeDefined();
  },
);
