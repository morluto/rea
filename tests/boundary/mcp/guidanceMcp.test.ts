import { expect, onTestFinished } from "vitest";
import { ArtifactResourceScope } from "../../../src/resources/ArtifactResourceScope.js";
import {
  readGuidanceSectionOutputSchema,
  searchGuidanceOutputSchema,
} from "../../../src/contracts/guidanceContracts.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { registerServiceTools } from "../../../src/server/serviceToolBindings.js";
import { silentLogger } from "../../../src/logger.js";
import { ToolResultDelivery } from "../../../src/server/ToolResultDelivery.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

const guidanceOutput = <T>(
  schema: { parse(value: unknown): T },
  value: unknown,
): T => {
  // MCP's legacy output-schema projection wraps root-level union schemas.
  // Newer transports pass the object unchanged.
  if (typeof value === "object" && value !== null && "result" in value)
    return schema.parse(value.result);
  return schema.parse(value);
};
mcpTest(
  "advertises provider-free tools and retrieves the best packaged match",
  async ({ mcp }) => {
    const server = new EvidenceMcpServer(
      { name: "guidance-test", version: "1" },
      { capabilities: { tools: { listChanged: true } } },
      undefined,
      new ToolResultDelivery(1024 * 1024),
    );
    const resources = new ArtifactResourceScope();
    onTestFinished(() => resources.close());
    const admitted: string[] = [];
    // Guidance is provider-free: it answers without entering analysis
    // admission, even when the server supplies one.
    registerServiceTools(
      server,
      { guidance: resources },
      {
        logger: silentLogger,
        withAdmittedAnalysis: (operationName) => {
          admitted.push(operationName);
          return Promise.reject(
            new Error("guidance entered analysis admission"),
          );
        },
      },
    );
    const client = await mcp.connect(server);

    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["search_guidance", "read_guidance_section"]),
    );
    const invalidLocator = await client.callTool({
      name: "read_guidance_section",
      arguments: { locator: "../../outside.md" },
    });
    expect(parseMcpToolError(invalidLocator).error).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ path: ["locator"], reason: "invalid_value" }] },
    });
    const invalidSearch = await client.callTool({
      name: "search_guidance",
      arguments: { query: "module", limit: 21, unexpected: true },
    });
    expect(parseMcpToolError(invalidSearch).error).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          { path: ["limit"], reason: "out_of_range", maximum: 20 },
          { path: ["unexpected"], reason: "unknown_argument" },
        ],
      },
    });
    const response = await client.callTool({
      name: "search_guidance",
      arguments: { query: "exact JavaScript module" },
    });
    expect(response.isError).not.toBe(true);
    const parsed = guidanceOutput(
      searchGuidanceOutputSchema,
      response.structuredContent,
    );
    if (parsed.status !== "matches")
      throw new Error("Expected guidance matches");
    expect(parsed).toMatchObject({
      source: "installed_rea_guidance",
      package: expect.stringMatching(/^rea-agents@/u),
    });
    const [selected] = parsed.matches;
    expect(selected).toMatchObject({
      guide: "references/javascript-applications.md",
      heading: "Read a module without repeating analysis",
      matched_terms: ["exact", "javascript", "module"],
      context: expect.stringContaining("javascript-module"),
    });
    if (selected === undefined)
      throw new Error("Expected the selected section");
    const section = await client.callTool({
      name: "read_guidance_section",
      arguments: { locator: selected.locator },
    });
    expect(section.isError).not.toBe(true);
    expect(
      guidanceOutput(
        readGuidanceSectionOutputSchema,
        section.structuredContent,
      ),
    ).toMatchObject({
      status: "section",
      guide: selected.guide,
      heading: selected.heading,
      locator: selected.locator,
      source: "installed_rea_guidance",
      content: expect.stringContaining("node_id"),
    });
    const firstPage = await client.callTool({
      name: "search_guidance",
      arguments: { query: "module", limit: 1 },
    });
    const firstResult = guidanceOutput(
      searchGuidanceOutputSchema,
      firstPage.structuredContent,
    );
    if (
      firstResult.status !== "matches" ||
      firstResult.next_cursor === undefined
    )
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
      guidanceOutput(searchGuidanceOutputSchema, nextPage.structuredContent),
    ).toMatchObject({ status: "matches", offset: 1 });
    expect(admitted).toEqual([]);
  },
);
