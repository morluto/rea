import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it } from "vitest";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import {
  readGuidanceSectionToolOutputSchema,
  searchGuidanceInputSchema,
  searchGuidanceToolOutputSchema,
} from "../../../src/contracts/guidanceContracts.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { registerGuidanceTools } from "../../../src/server/registerGuidanceTools.js";
import { ToolResultDelivery } from "../../../src/server/ToolResultDelivery.js";

const open: {
  client: Client;
  server: EvidenceMcpServer;
  resources: ArtifactResourceScope;
}[] = [];
// Every successful guidance result is the advertised object with `result`.
const guidanceOutput = <T>(
  schema: { parse(value: unknown): { readonly result: T } },
  value: unknown,
): T => schema.parse(value).result;
afterEach(async () => {
  await Promise.all(
    open
      .splice(0)
      .flatMap(({ client, server, resources }) => [
        client.close(),
        server.close(),
        resources.close(),
      ]),
  );
});

it("advertises strict provider-free contracts and returns packaged guide results over MCP", async () => {
  const server = new EvidenceMcpServer(
    { name: "guidance-test", version: "1" },
    { capabilities: { tools: { listChanged: true } } },
    undefined,
    new ToolResultDelivery(1024 * 1024),
  );
  const resources = new ArtifactResourceScope();
  registerGuidanceTools(server, resources);
  const client = new Client({ name: "guidance-client", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push({ client, server, resources });

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
  const response = await client.callTool({
    name: "search_guidance",
    arguments: { query: "exact JavaScript module" },
  });
  expect(response.isError).not.toBe(true);
  const parsed = guidanceOutput(
    searchGuidanceToolOutputSchema,
    response.structuredContent,
  );
  expect(parsed).toMatchObject({
    status: "matches",
    source: "installed_rea_guidance",
  });
  if (parsed.status !== "matches") throw new Error("Expected guidance matches");
  const selected = parsed.matches.find(
    ({ heading }) => heading === "Read a module without repeating analysis",
  );
  expect(selected).toBeDefined();
  const section = await client.callTool({
    name: "read_guidance_section",
    arguments: { locator: selected?.locator },
  });
  expect(section.isError).not.toBe(true);
  expect(
    guidanceOutput(
      readGuidanceSectionToolOutputSchema,
      section.structuredContent,
    ),
  ).toMatchObject({
    status: "section",
    heading: selected?.heading,
    source: "installed_rea_guidance",
  });
  const firstPage = await client.callTool({
    name: "search_guidance",
    arguments: { query: "module", limit: 1 },
  });
  const firstResult = guidanceOutput(
    searchGuidanceToolOutputSchema,
    firstPage.structuredContent,
  );
  if (firstResult.status !== "matches" || firstResult.next_cursor === undefined)
    throw new Error("Expected a guidance continuation token");
  const nextPage = await client.callTool({
    name: "search_guidance",
    arguments: {
      query: "module",
      limit: 1,
      cursor: firstResult.next_cursor,
    },
  });
  expect(
    guidanceOutput(searchGuidanceToolOutputSchema, nextPage.structuredContent),
  ).toMatchObject({ status: "matches", offset: 1 });
});
