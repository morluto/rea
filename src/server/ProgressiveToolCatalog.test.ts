import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { EvidenceMcpServerCore } from "./EvidenceMcpServerCore.js";
import { ToolResultDelivery } from "./ToolResultDelivery.js";
import { parseMcpToolError } from "../../tests/fixtures/mcpToolError.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const connect = async (
  options: { replyBytes?: number; bulk?: boolean } = {},
) => {
  const bulkNames = options.bulk
    ? Array.from(
        { length: 20 },
        (_, index) => `bulk_${String(index).padStart(2, "0")}`,
      )
    : [];
  const server = new EvidenceMcpServerCore(
    { name: "catalog-test", version: "1" },
    { capabilities: {} },
    undefined,
    new ToolResultDelivery(options.replyBytes ?? 1024 * 1024),
    undefined,
    undefined,
    {
      counts: {
        cli_commands: 0,
        mcp_tools: 3 + bulkNames.length,
        mcp_prompts: 0,
      },
      digests: {
        tools_sha256: "tools",
        prompts_sha256: "prompts",
        combined_sha256: "combined",
      },
    },
  );
  const forbidden = vi.fn();
  for (const name of [
    "binary_session",
    "alpha_sqlite",
    "beta_sqlite",
    "excluded_sqlite",
    ...bulkNames,
  ]) {
    const registration = server.registerTool(
      name,
      {
        description: `${name} SQLite database inspection`,
        inputSchema: name.startsWith("bulk_")
          ? z.strictObject({
              payload: z.string().describe("schema guidance ".repeat(64)),
            })
          : z.strictObject({}),
      },
      () => {
        if (name === "excluded_sqlite") forbidden();
        return { content: [] };
      },
    );
    if (name === "excluded_sqlite") registration.disable();
  }
  server.enableProgressiveCatalog();
  const client = new Client({ name: "catalog-test-client", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  cleanup.push(
    () => server.close(),
    () => client.close(),
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const changed = vi.fn();
  client.setNotificationHandler("notifications/tools/list_changed", changed);
  const discover = (args: Record<string, unknown>) =>
    client.callTool({ name: "discover_tools", arguments: args });
  return { client, changed, discover, forbidden, bulkNames };
};

it("refuses an oversized maximum page before loading, then delivers every original contract in smaller pages", async () => {
  const replyBytes = 8 * 1024;
  const f = await connect({ replyBytes, bulk: true });
  const initial = await f.client.listTools();
  const refused = await f.discover({ query: "bulk", limit: 20 });
  expect(refused.isError).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(refused))).toBeLessThanOrEqual(
    replyBytes - 1024,
  );
  const text = refused.content.find((part) => part.type === "text")?.text;
  expect(JSON.parse(text ?? "null")).toMatchObject({
    error: {
      code: "resource_constraint",
      remediation: { action: expect.stringContaining("Reduce limit") },
    },
  });
  expect(await f.client.listTools()).toEqual(initial);
  expect(f.changed).not.toHaveBeenCalled();
  const seen: string[] = [];
  for (let offset = 0; offset < 20; offset++) {
    const result = await f.discover({ query: "bulk", limit: 1, offset });
    expect(result.isError).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      replyBytes - 1024,
    );
    expect(result.structuredContent).toMatchObject({
      total_matches: 20,
      next_offset: offset === 19 ? null : offset + 1,
      loaded_count: offset + 3,
    });
    const page = JSON.parse(
      result.content.find((part) => part.type === "text")?.text ?? "null",
    );
    const tool = page.tools[0];
    seen.push(tool.name);
    expect(
      (await f.client.listTools()).tools.find(({ name }) => name === tool.name)
        ?.inputSchema,
    ).toEqual(tool.input_schema);
  }
  expect(seen).toEqual(f.bulkNames);
  expect(f.changed).toHaveBeenCalledTimes(20);
});

it("bounds an oversized unknown-name failure without changing visibility", async () => {
  const replyBytes = 8 * 1024;
  const f = await connect({ replyBytes });
  const initial = await f.client.listTools();
  const result = await f.discover({ names: ["unknown".repeat(4096)] });
  expect(parseMcpToolError(result)).toMatchObject({
    error: {
      code: "resource_constraint",
      details: { reported_limits: { original_error_code: "invalid_request" } },
    },
  });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
    replyBytes - 1024,
  );
  expect(await f.client.listTools()).toEqual(initial);
  expect(f.changed).not.toHaveBeenCalled();
});

it("batches visibility changes, pages searches, and keeps excluded tools outside discovery", async () => {
  const f = await connect();
  const first = await f.discover({ query: "sqlite", limit: 1 });
  expect(first.structuredContent).toMatchObject({
    inventory_count: 4,
    loaded_count: 3,
    total_matches: 3,
    next_offset: 1,
    tools: [{ name: "alpha_sqlite" }],
  });
  expect(f.changed).toHaveBeenCalledTimes(1);
  const visible = await f.client.listTools();
  for (const args of [
    { query: "sqlite", offset: 3, limit: 1 },
    { query: "missing_word" },
  ]) {
    expect((await f.discover(args)).isError).not.toBe(true);
    expect(await f.client.listTools()).toEqual(visible);
    expect(f.changed).toHaveBeenCalledTimes(1);
  }
  const next = await f.discover({ query: "sqlite", offset: 1, limit: 2 });
  expect(next.structuredContent).toMatchObject({
    loaded_count: 4,
    next_offset: null,
    tools: [{ name: "beta_sqlite" }, { name: "binary_session" }],
  });
  expect(f.changed).toHaveBeenCalledTimes(2);
  await f.discover({ names: ["alpha_sqlite", "beta_sqlite"] });
  expect(f.changed).toHaveBeenCalledTimes(2);
  expect((await f.discover({ names: ["excluded_sqlite"] })).isError).toBe(true);
  await expect(
    f.client.callTool({ name: "excluded_sqlite", arguments: {} }),
  ).rejects.toThrow("disabled");
  expect(f.forbidden).not.toHaveBeenCalled();
});

it("loads exact names atomically and emits one notification for a batch", async () => {
  const f = await connect();
  expect(
    (await f.discover({ names: ["alpha_sqlite", "missing"] })).isError,
  ).toBe(true);
  expect((await f.client.listTools()).tools.map(({ name }) => name)).toEqual([
    "binary_session",
    "discover_tools",
  ]);
  expect(f.changed).not.toHaveBeenCalled();
  const result = await f.discover({
    names: ["beta_sqlite", "alpha_sqlite", "alpha_sqlite"],
  });
  expect(result.structuredContent).toMatchObject({
    tools: [{ name: "beta_sqlite" }, { name: "alpha_sqlite" }],
    total_matches: 2,
  });
  expect(f.changed).toHaveBeenCalledTimes(1);
});

it.each([
  { names: [] },
  { names: ["alpha_sqlite"], query: "sqlite" },
  { names: ["alpha_sqlite"], offset: 1 },
  { limit: 21 },
  { offset: -1 },
  { names: ["alpha_sqlite"], extra: true },
])(
  "rejects malformed discovery before changing visibility: %j",
  async (args) => {
    const f = await connect();
    expect((await f.discover(args)).isError).toBe(true);
    expect((await f.client.listTools()).tools).toHaveLength(2);
    expect(f.changed).not.toHaveBeenCalled();
  },
);

it("ranks multi-word task queries by relevance instead of failing with zero matches (#11707)", async () => {
  const f = await connect();

  // 1. More matched words reverses alphabetical order:
  // "inspection beta missing_token" matches beta_sqlite (2 words: beta in name, inspection in desc),
  // but only 1 word for alpha_sqlite and binary_session (inspection in desc).
  // beta_sqlite must rank before alpha_sqlite despite "beta" > "alpha" alphabetically.
  const reverseAlphaResult = await f.discover({
    query: "inspection beta missing_token",
    limit: 10,
  });
  expect(reverseAlphaResult.isError).not.toBe(true);
  const reverseToolNames = (
    reverseAlphaResult.structuredContent as { tools: Array<{ name: string }> }
  ).tools.map((t) => t.name);
  expect(reverseToolNames).toEqual([
    "beta_sqlite",
    "alpha_sqlite",
    "binary_session",
  ]);

  // 2. Equal word counts (1 hit each) settled by a name hit over description-only hit:
  // "sqlite" matches 1 word in all 3 tools, but alpha_sqlite and beta_sqlite have name hits,
  // while binary_session only has a description hit.
  const nameHitResult = await f.discover({
    query: "sqlite",
    limit: 10,
  });
  expect(nameHitResult.isError).not.toBe(true);
  const nameHitToolNames = (
    nameHitResult.structuredContent as { tools: Array<{ name: string }> }
  ).tools.map((t) => t.name);
  expect(nameHitToolNames).toEqual([
    "alpha_sqlite",
    "beta_sqlite",
    "binary_session",
  ]);

  // 3. When one tool matches all query words, it ranks strictly before partial matches:
  const priorityResult = await f.discover({
    query: "alpha sqlite inspection",
    limit: 10,
  });
  expect(priorityResult.isError).not.toBe(true);
  const priorityToolNames = (
    priorityResult.structuredContent as { tools: Array<{ name: string }> }
  ).tools.map((t) => t.name);
  expect(priorityToolNames[0]).toBe("alpha_sqlite");
  expect(priorityToolNames.slice(1)).toEqual(["beta_sqlite", "binary_session"]);
});
