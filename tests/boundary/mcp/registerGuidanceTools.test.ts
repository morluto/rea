import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterAll, afterEach, expect, it } from "vitest";
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
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

const schemaValidation = createMcpSchemaValidation();
afterAll(() => schemaValidation.clear());
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

const REVISIONS = ["2025-11-25", "2026-07-28"] as const;

const connectGuidance = async (revision: (typeof REVISIONS)[number]) => {
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
    {
      jsonSchemaValidator: schemaValidation,
      ...(revision === "2026-07-28"
        ? { versionNegotiation: { mode: { pin: revision } } }
        : { supportedProtocolVersions: [revision] }),
    },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  // The production stdio entry owns the era decision for the connection.
  const serving = serveStdio(() => server, { transport: serverTransport });
  open.push({ client, serving, resources });
  await client.connect(clientTransport);
  expect(client.getNegotiatedProtocolVersion()).toBe(revision);
  const advertised = {
    search_guidance: await advertisedMcpToolSchemas(
      client,
      "search_guidance",
      schemaValidation.assertions,
    ),
    read_guidance_section: await advertisedMcpToolSchemas(
      client,
      "read_guidance_section",
      schemaValidation.assertions,
    ),
  };
  // A typeless union root is wrapped in `{result}` by 2025-era projections and
  // left bare by 2026-era ones, so clients disagree about the payload shape.
  for (const [name, { outputSchema }] of Object.entries(advertised))
    expect(outputSchema.type, name).toBe("object");
  return { client, advertised };
};

/** Guidance results must be the advertised object itself on every revision. */
const guidanceResult = async <T>(
  { client, advertised }: Awaited<ReturnType<typeof connectGuidance>>,
  name: keyof Awaited<ReturnType<typeof connectGuidance>>["advertised"],
  schema: { parse(value: unknown): T },
  arguments_: Record<string, unknown>,
): Promise<T> => {
  const { ajv, outputSchema, toolDefinition } = advertised[name];
  const response = await client.callTool(
    { name, arguments: arguments_ },
    { toolDefinition },
  );
  expect(response.isError).not.toBe(true);
  expect(
    ajv.validate(outputSchema, response.structuredContent),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  return schema.parse(response.structuredContent);
};

it.each(REVISIONS)(
  "returns guidance results that match the advertised output schemas on %s",
  async (revision) => {
    const connection = await connectGuidance(revision);
    expect(
      await guidanceResult(
        connection,
        "search_guidance",
        searchGuidanceOutputSchema,
        { query: "web application clone", limit: 10 },
      ),
    ).toMatchObject({
      source: "installed_rea_guidance",
      query: "web application clone",
    });
    expect(
      await guidanceResult(
        connection,
        "search_guidance",
        searchGuidanceOutputSchema,
        { query: "browser scenario", limit: 10 },
      ),
    ).toMatchObject({ status: "matches", query: "browser scenario" });

    const parsed = await guidanceResult(
      connection,
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
        connection,
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

it.each(REVISIONS)(
  "rejects invalid guidance input and pages packaged guide results on %s",
  async (revision) => {
    const connection = await connectGuidance(revision);
    const { client } = connection;
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
      connection,
      "search_guidance",
      searchGuidanceOutputSchema,
      { query: "module", limit: 1 },
    );
    if (
      firstResult.status !== "matches" ||
      firstResult.next_cursor === undefined
    )
      throw new Error("Expected a guidance continuation token");
    expect(
      await guidanceResult(
        connection,
        "search_guidance",
        searchGuidanceOutputSchema,
        { query: "module", limit: 1, cursor: firstResult.next_cursor },
      ),
    ).toMatchObject({ status: "matches", offset: 1 });
  },
);
