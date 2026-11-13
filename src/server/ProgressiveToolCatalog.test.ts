import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { EvidenceMcpServerCore } from "./EvidenceMcpServerCore.js";
import { discoveryPreview } from "./ProgressiveToolCatalog.js";
import { ToolResultDelivery } from "./ToolResultDelivery.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const connect = async (
  options: {
    replyBytes?: number;
    bulk?: boolean;
    extra?: ReadonlyArray<{ name: string; description: string }>;
  } = {},
) => {
  const bulkNames = options.bulk
    ? Array.from(
        { length: 20 },
        (_, index) => `bulk_${String(index).padStart(2, "0")}`,
      )
    : [];
  const extra = options.extra ?? [];
  const server = new EvidenceMcpServerCore(
    { name: "catalog-test", version: "1" },
    { capabilities: {} },
    undefined,
    new ToolResultDelivery(options.replyBytes ?? 1024 * 1024),
    undefined,
    "full",
    {
      counts: {
        cli_commands: 0,
        mcp_tools: 3 + bulkNames.length + extra.length,
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
    ...extra.map((tool) => tool.name),
  ]) {
    const described = extra.find((tool) => tool.name === name);
    const registration = server.registerTool(
      name,
      {
        description:
          described?.description ?? `${name} SQLite database inspection`,
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
  return { server, client, changed, discover, forbidden };
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
  expect(new Set(seen).size).toBe(20);
  expect(f.changed).toHaveBeenCalledTimes(20);
});

it("bounds an oversized unknown-name failure without changing visibility", async () => {
  const replyBytes = 8 * 1024;
  const f = await connect({ replyBytes });
  const initial = await f.client.listTools();
  const result = await f.discover({ names: ["unknown".repeat(4096)] });
  expect(result.isError).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
    replyBytes - 1024,
  );
  expect(await f.client.listTools()).toEqual(initial);
  expect(f.changed).not.toHaveBeenCalled();
});

it("batches visibility changes, pages searches, and keeps excluded tools outside discovery", async () => {
  const f = await connect();
  const identity = f.server.catalogIdentity;
  const first = await f.discover({ query: "sqlite", limit: 1 });
  expect(first.structuredContent).toMatchObject({
    inventory_count: 4,
    loaded_count: 3,
    total_matches: 3,
    next_offset: 1,
    tools: [{ name: "alpha_sqlite" }],
  });
  const next = await f.discover({ query: "sqlite", offset: 1, limit: 2 });
  expect(next.structuredContent).toMatchObject({
    loaded_count: 4,
    next_offset: null,
    tools: [{ name: "beta_sqlite" }, { name: "binary_session" }],
  });
  expect(f.changed).toHaveBeenCalledTimes(2);
  await f.discover({ names: ["alpha_sqlite", "beta_sqlite"] });
  expect(f.changed).toHaveBeenCalledTimes(2);
  expect(
    (await f.discover({ query: "missing_word" })).structuredContent,
  ).toMatchObject({ total_matches: 0, tools: [], next_offset: null });
  expect((await f.discover({ names: ["excluded_sqlite"] })).isError).toBe(true);
  await expect(
    f.client.callTool({ name: "excluded_sqlite", arguments: {} }),
  ).rejects.toThrow("disabled");
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(f.server.catalogIdentity).toEqual(identity);
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

it("distinguishes exhausted pages from unmatched queries without loading tools", async () => {
  const f = await connect();
  const before = await f.client.listTools();
  for (const offset of [3, 4, 100]) {
    const reply = await f.discover({ query: "sqlite", offset, limit: 1 });
    expect(reply.isError).not.toBe(true);
    expect(reply.structuredContent).toMatchObject({
      total_matches: 3,
      tools: [],
      next_offset: null,
      next_step: expect.stringContaining("offset 0"),
    });
    expect(
      z.object({ next_step: z.string() }).parse(reply.structuredContent)
        .next_step,
    ).not.toContain("No matches.");
    expect(await f.client.listTools()).toEqual(before);
  }
  const unmatched = await f.discover({
    query: "no_such_keyword",
    offset: 100,
    limit: 1,
  });
  expect(unmatched.structuredContent).toMatchObject({
    total_matches: 0,
    tools: [],
    next_offset: null,
    next_step: expect.stringContaining("No matches."),
  });
  expect(f.changed).not.toHaveBeenCalled();
  const last = await f.discover({ query: "sqlite", offset: 2, limit: 1 });
  expect(last.structuredContent).toMatchObject({
    total_matches: 3,
    tools: [{ name: "binary_session" }],
    next_offset: null,
    next_step: expect.stringContaining("Call the returned tool"),
  });
});

it("ranks a leading task word ahead of an alphabetical later mention", async () => {
  const buried = `${"padding ".repeat(40)}javascript module graph`;
  const commonThenLate = `${"notes ".repeat(50)}javascript module graph`;
  const f = await connect({
    extra: [
      { name: "alpha_calendar", description: "calendar export" },
      { name: "alpha_misc", description: buried },
      { name: "notes_misc", description: commonThenLate },
      {
        name: "zebra_misc",
        description: "javascript module graph for bundles",
      },
    ],
  });
  const first = await f.discover({ query: "javascript", limit: 1 });
  expect(first.structuredContent).toMatchObject({
    total_matches: 3,
    tools: [{ name: "zebra_misc" }],
  });
  const page = await f.discover({ query: "javascript", limit: 3 });
  const tools = z
    .object({
      tools: z.array(z.object({ name: z.string(), description: z.string() })),
    })
    .parse(page.structuredContent).tools;
  expect(tools.map((tool) => tool.name)).toEqual([
    "zebra_misc",
    "notes_misc",
    "alpha_misc",
  ]);
  const latePreview = tools[1]?.description ?? "";
  expect(latePreview.length).toBeLessThanOrEqual(240);
  expect(latePreview.startsWith("notes")).toBe(true);
  expect(latePreview).toContain("javascript");
  const buriedPreview = tools[2]?.description ?? "";
  expect(buriedPreview.length).toBeLessThanOrEqual(240);
  expect(buriedPreview.startsWith("padding")).toBe(true);
  expect(buriedPreview).toContain("javascript");
  const notesPage = await f.discover({ query: "notes javascript", limit: 1 });
  const notesTool = z
    .object({
      tools: z.array(z.object({ name: z.string(), description: z.string() })),
    })
    .parse(notesPage.structuredContent).tools[0];
  expect(notesTool?.name).toBe("notes_misc");
  expect(notesTool?.description.length ?? 0).toBeLessThanOrEqual(240);
  expect(notesTool?.description).toContain("javascript");
  expect(notesTool?.description.startsWith("notes")).toBe(true);
});

it("ranks an affirmative task ahead of an alphabetical denial and keeps that task sentence", async () => {
  const task = "Inspect a saved local HAR capture.";
  const description = `${task}${" recorded ".repeat(30)}This does not prove network loss.`;
  const f = await connect({
    extra: [
      {
        name: "alpha_misc",
        description: "Export packets without network access.",
      },
      { name: "network_misc", description: "calendar export" },
      { name: "zebra_misc", description: "Inspect captured network records." },
      { name: "notes_misc", description },
    ],
  });
  const page = await f.discover({ query: "network", limit: 4 });
  const tools = z
    .object({
      tools: z.array(z.object({ name: z.string(), description: z.string() })),
    })
    .parse(page.structuredContent).tools;
  expect(tools.map((tool) => tool.name)).toEqual([
    "network_misc",
    "zebra_misc",
    "alpha_misc",
    "notes_misc",
  ]);
  const preview = tools[3]?.description ?? "";
  expect(preview.length).toBeLessThanOrEqual(240);
  expect(preview.startsWith(task)).toBe(true);
  expect(preview).toContain("network");
  expect(preview).toContain("not");
});

it("drops tools loaded by the previous connection on the same server", async () => {
  const f = await connect();
  await f.discover({ names: ["alpha_sqlite"] });
  await f.client.close();
  const client = new Client({ name: "catalog-next-connection", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  cleanup.push(() => client.close());
  await f.server.connect(serverTransport);
  await client.connect(clientTransport);
  expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
    "binary_session",
    "discover_tools",
  ]);
});

it("keeps tools loaded in one catalog invisible to another", async () => {
  const first = await connect();
  const second = await connect();
  await first.discover({ names: ["alpha_sqlite"] });
  expect(
    (await first.client.listTools()).tools.map(({ name }) => name),
  ).toContain("alpha_sqlite");
  expect(
    (await second.client.listTools()).tools.map(({ name }) => name),
  ).toEqual(["binary_session", "discover_tools"]);
});

it("keeps a denial in the same sentence ahead of the next sentence", async () => {
  const f = await connect({
    extra: [
      {
        name: "alpha_misc",
        description: "Measure startup time. Does not open a target.",
      },
      {
        name: "zebra_misc",
        description: `${"padding ".repeat(40)}startup probe`,
      },
    ],
  });
  const page = await f.discover({ query: "startup", limit: 2 });
  const tools = z
    .object({ tools: z.array(z.object({ name: z.string() })) })
    .parse(page.structuredContent).tools;
  expect(tools.map((tool) => tool.name)).toEqual(["alpha_misc", "zebra_misc"]);
});

it("keeps the governing not when a late match has a long tail", () => {
  const description =
    "Push one local file to an absolute device path. If the destination is an existing directory, adb places the file inside it under the local basename and the result reports that file path. A device-mutating tool: checks for an existing destination file before transfer and refuses it unless overwrite is explicitly requested; this check is not atomic and another process can create the path before adb writes. The private staged copy remains non-writable and preserves source executable bits.";
  const preview = discoveryPreview(description, ["atomic"]);
  expect(preview.length).toBeLessThanOrEqual(240);
  expect(preview.startsWith("Push one local file")).toBe(true);
  expect(preview).toContain("not atomic");
});

it("finds one late hit when the query repeats that word", () => {
  const description = `${"padding ".repeat(40)}120-second budget for recovery`;
  const preview = discoveryPreview(
    description,
    Array.from({ length: 4000 }, () => "120-second"),
  );
  expect(preview.length).toBeLessThanOrEqual(240);
  expect(preview).toContain("120-second");
});
