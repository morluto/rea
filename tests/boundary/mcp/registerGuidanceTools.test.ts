import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, expect, it } from "vitest";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import {
  readGuidanceSectionOutputSchema,
  searchGuidanceInputSchema,
  searchGuidanceOutputSchema,
} from "../../../src/contracts/guidanceContracts.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { registerGuidanceTools } from "../../../src/server/registerGuidanceTools.js";
import { ToolResultDelivery } from "../../../src/server/ToolResultDelivery.js";
import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";

const open: {
  client: Client;
  serving: ReturnType<typeof serveStdio>;
  resources: ArtifactResourceScope;
}[] = [];
afterEach(async () => {
  await Promise.all(
    open
      .splice(0)
      .flatMap(({ client, serving, resources }) => [
        client.close(),
        serving.close(),
        resources.close(),
      ]),
  );
});

const connectGuidance = async (
  revision: "2025-11-25" | "2026-07-28",
): Promise<Client> => {
  const server = new EvidenceMcpServer(
    { name: "guidance-test", version: "1" },
    { capabilities: { tools: { listChanged: true } } },
    undefined,
    new ToolResultDelivery(1024 * 1024),
  );
  const resources = new ArtifactResourceScope();
  registerGuidanceTools(server, resources);
  const client = new Client(
    { name: "guidance-client", version: "1" },
    revision === "2026-07-28"
      ? { versionNegotiation: { mode: { pin: revision } } }
      : { supportedProtocolVersions: [revision] },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  // The production stdio entry owns the era decision for the connection.
  const serving = serveStdio(() => server, { transport: serverTransport });
  open.push({ client, serving, resources });
  await client.connect(clientTransport);
  expect(client.getNegotiatedProtocolVersion()).toBe(revision);
  return client;
};

/**
 * A typeless union root is wrapped in `{result}` by 2025-era projections and
 * left bare by 2026-era ones, so clients disagree about the payload shape.
 * Guidance results must be the advertised object itself on every revision.
 */
const guidanceResult = async <T>(
  client: Client,
  name: "search_guidance" | "read_guidance_section",
  schema: { parse(value: unknown): T },
  arguments_: Record<string, unknown>,
): Promise<T> => {
  const advertised = await advertisedMcpToolSchemas(client, name);
  expect(advertised.outputSchema.type, name).toBe("object");
  const response = await client.callTool({ name, arguments: arguments_ });
  expect(response.isError).not.toBe(true);
  expect(
    advertised.ajv.validate(
      advertised.outputSchema,
      response.structuredContent,
    ),
    JSON.stringify(advertised.ajv.errors),
  ).toBe(true);
  return schema.parse(response.structuredContent);
};

it.each(["2025-11-25", "2026-07-28"] as const)(
  "returns guidance results that match the advertised output schemas on %s",
  async (revision) => {
    const client = await connectGuidance(revision);
    for (const query of ["web application clone", "browser scenario"])
      expect(
        await guidanceResult(
          client,
          "search_guidance",
          searchGuidanceOutputSchema,
          {
            query,
            limit: 10,
          },
        ),
      ).toMatchObject({ source: "installed_rea_guidance", query });

    const parsed = await guidanceResult(
      client,
      "search_guidance",
      searchGuidanceOutputSchema,
      { query: "exact JavaScript module" },
    );
    if (parsed.status !== "matches")
      throw new Error("Expected guidance matches");
    const selected = parsed.matches.find(
      ({ heading }) => heading === "Read a module without repeating analysis",
    );
    expect(selected).toBeDefined();
    expect(
      await guidanceResult(
        client,
        "read_guidance_section",
        readGuidanceSectionOutputSchema,
        { locator: selected?.locator },
      ),
    ).toMatchObject({
      status: "section",
      heading: selected?.heading,
      source: "installed_rea_guidance",
    });
  },
);

it("advertises strict provider-free contracts and pages packaged guide results over MCP", async () => {
  const client = await connectGuidance("2025-11-25");
  const listed = await client.listTools();
  expect(listed.tools.map(({ name }) => name)).toEqual(
    expect.arrayContaining(["search_guidance", "read_guidance_section"]),
  );
  expect(
    searchGuidanceInputSchema.safeParse({
      query: "module",
      unexpected: true,
    }).success,
  ).toBe(false);
  const invalidLocator = await client.callTool({
    name: "read_guidance_section",
    arguments: { locator: "../../outside.md" },
  });
  expect(invalidLocator.isError).toBe(true);
  const invalidLimit = await client.callTool({
    name: "search_guidance",
    arguments: { query: "module", limit: 21 },
  });
  expect(invalidLimit.isError).toBe(true);
  const firstResult = await guidanceResult(
    client,
    "search_guidance",
    searchGuidanceOutputSchema,
    { query: "module", limit: 1 },
  );
  if (firstResult.status !== "matches" || firstResult.next_cursor === undefined)
    throw new Error("Expected a guidance continuation token");
  expect(
    await guidanceResult(
      client,
      "search_guidance",
      searchGuidanceOutputSchema,
      {
        query: "module",
        limit: 1,
        cursor: firstResult.next_cursor,
      },
    ),
  ).toMatchObject({ status: "matches", offset: 1 });
});
