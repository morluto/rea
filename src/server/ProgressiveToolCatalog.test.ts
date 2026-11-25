import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { DISCOVER_TOOLS } from "../contracts/catalog/catalogDiscovery.js";
import { EvidenceMcpServerCore } from "./EvidenceMcpServerCore.js";
import { ToolResultDelivery } from "./ToolResultDelivery.js";
import { parseMcpToolError } from "../../tests/fixtures/mcpToolError.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const connect = async (
  options: {
    replyBytes?: number;
    bulk?: boolean;
    extraTools?: Array<{ name: string; description: string }>;
  } = {},
) => {
  const bulkNames = options.bulk
    ? Array.from(
        { length: 20 },
        (_, index) => `bulk_${String(index).padStart(2, "0")}`,
      )
    : [];
  const extraTools = options.extraTools ?? [];
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
        mcp_tools: 3 + bulkNames.length + extraTools.length,
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
  for (const extra of extraTools) {
    server.registerTool(
      extra.name,
      { description: extra.description, inputSchema: z.strictObject({}) },
      () => ({ content: [] }),
    );
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

it("bounds both discovery refusals, then loads the same inventory in fitting pages", async () => {
  const replyBytes = 8 * 1024;
  const f = await connect({ replyBytes, bulk: true });
  const initial = await f.client.listTools();
  for (const { args, error } of [
    {
      args: { query: "bulk", limit: 20 },
      error: {
        remediation: { action: expect.stringContaining("Reduce limit") },
      },
    },
    {
      args: { names: ["unknown".repeat(4096)] },
      error: {
        details: {
          reported_limits: { original_error_code: "invalid_request" },
        },
      },
    },
  ]) {
    const refused = await f.discover(args);
    expect(parseMcpToolError(refused)).toMatchObject({
      error: { code: "resource_constraint", ...error },
    });
    expect(Buffer.byteLength(JSON.stringify(refused))).toBeLessThanOrEqual(
      replyBytes - 1024,
    );
    expect(await f.client.listTools()).toEqual(initial);
    expect(f.changed).not.toHaveBeenCalled();
  }
  const pageSize = 3;
  for (let offset = 0; offset < f.bulkNames.length; offset += pageSize) {
    const result = await f.discover({ query: "bulk", limit: pageSize, offset });
    expect(result.isError).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      replyBytes - 1024,
    );
    const page = DISCOVER_TOOLS.outputSchema.parse(result.structuredContent);
    const names = f.bulkNames.slice(offset, offset + pageSize);
    const end = offset + names.length;
    expect(page).toMatchObject({
      total_matches: f.bulkNames.length,
      next_offset: end < f.bulkNames.length ? end : null,
      loaded_count: initial.tools.length + end,
      tools: names.map((name) => ({ name })),
    });
    const text = result.content.find((part) => part.type === "text")?.text;
    expect(JSON.parse(text ?? "null")).toEqual(page);

    const advertised = (await f.client.listTools()).tools;
    expect(advertised.map(({ name }) => name).sort()).toEqual(
      [
        ...initial.tools.map(({ name }) => name),
        ...f.bulkNames.slice(0, end),
      ].sort(),
    );
    for (const tool of page.tools)
      expect(
        advertised.find(({ name }) => name === tool.name)?.inputSchema,
      ).toEqual(tool.input_schema);
  }
  expect(f.changed).toHaveBeenCalledTimes(
    Math.ceil(f.bulkNames.length / pageSize),
  );
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

it("accepts its own advertised name like an already-loaded tool", async () => {
  const f = await connect();
  const advertised = (await f.client.listTools()).tools.find(
    ({ name }) => name === "discover_tools",
  );
  const self = await f.discover({ names: ["discover_tools"] });
  expect(self.isError).not.toBe(true);
  expect(self.structuredContent).toMatchObject({
    inventory_count: 4,
    loaded_count: 2,
    total_matches: 1,
    tools: [{ name: "discover_tools", input_schema: advertised?.inputSchema }],
  });
  expect(f.changed).not.toHaveBeenCalled();
  expect(
    (await f.discover({ names: ["discover_tools", "missing"] })).isError,
  ).toBe(true);
  expect(f.changed).not.toHaveBeenCalled();
  const mixed = await f.discover({ names: ["alpha_sqlite", "discover_tools"] });
  expect(mixed.structuredContent).toMatchObject({
    loaded_count: 3,
    tools: [{ name: "alpha_sqlite" }, { name: "discover_tools" }],
  });
  expect((await f.client.listTools()).tools.map(({ name }) => name)).toEqual([
    "binary_session",
    "alpha_sqlite",
    "discover_tools",
  ]);
  expect(f.changed).toHaveBeenCalledTimes(1);
});

it("rejects every malformed discovery without changing visibility", async () => {
  const f = await connect();
  const initial = await f.client.listTools();
  for (const args of [
    { names: [] },
    { names: ["alpha_sqlite"], query: "sqlite" },
    { names: ["alpha_sqlite"], offset: 1 },
    { limit: 21 },
    { offset: -1 },
    { names: ["alpha_sqlite"], extra: true },
  ]) {
    expect((await f.discover(args)).isError, JSON.stringify(args)).toBe(true);
    expect(await f.client.listTools()).toEqual(initial);
    expect(f.changed).not.toHaveBeenCalled();
  }
});

it("ranks name matches ahead of description-only matches and caches projected input schemas", async () => {
  const f = await connect({ bulk: true });
  const first = await f.discover({ query: "sqlite", limit: 3 });
  const firstPage = DISCOVER_TOOLS.outputSchema.parse(first.structuredContent);
  expect(firstPage.tools.map(({ name }) => name)).toEqual([
    "alpha_sqlite",
    "beta_sqlite",
    "binary_session",
  ]);
  const repeat = await f.discover({
    names: ["alpha_sqlite", "bulk_00"],
  });
  const repeatPage = DISCOVER_TOOLS.outputSchema.parse(
    repeat.structuredContent,
  );
  expect(repeatPage.tools[0]?.input_schema).toEqual(
    firstPage.tools[0]?.input_schema,
  );
  expect(repeatPage.loaded_count).toBe(5);
});

it("returns ranked matches for multi-word task queries when not every word appears (#11707)", async () => {
  const f = await connect({
    bulk: false,
    extraTools: [
      { name: "a_sqlite", description: "Single keyword match" },
      { name: "z_inspector", description: "Inspect schema tables" },
    ],
  });

  // More matched words in description (z_inspector: 2 words, 0 name matches)
  // outranks fewer matched words with a name match and earlier alphabetical name
  // (a_sqlite: 1 word, 1 name match).
  const byCount = DISCOVER_TOOLS.outputSchema.parse(
    (await f.discover({ query: "sqlite schema tables", limit: 4 }))
      .structuredContent,
  );
  expect(byCount.tools[0]?.name).toBe("z_inspector");
  expect(byCount.tools.map(({ name }) => name)).toContain("a_sqlite");

  // Repeated query words are deduplicated so they cannot inflate matchedWords.
  const repeated = DISCOVER_TOOLS.outputSchema.parse(
    (await f.discover({ query: "sqlite sqlite schema tables", limit: 4 }))
      .structuredContent,
  );
  expect(repeated.tools[0]?.name).toBe("z_inspector");

  // Underscore-named tools and multi-word queries rank cleanly without
  // splitting hyphenated tokens into accidental substring matches.
  const exactPrefix = DISCOVER_TOOLS.outputSchema.parse(
    (await f.discover({ query: "alpha_sqlite nonexistent", limit: 3 }))
      .structuredContent,
  );
  expect(exactPrefix.total_matches).toBeGreaterThanOrEqual(1);
  expect(exactPrefix.tools[0]?.name).toBe("alpha_sqlite");

  const unmatched = DISCOVER_TOOLS.outputSchema.parse(
    (await f.discover({ query: "alpha-no-such-tool-9995", limit: 3 }))
      .structuredContent,
  );
  expect(unmatched.total_matches).toBe(0);
  expect(unmatched.tools).toEqual([]);
});
