import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resolve } from "node:path";
import { expect, it } from "vitest";

import {
  readGuidanceSectionToolOutputSchema,
  searchGuidanceToolOutputSchema,
} from "../../../src/contracts/guidanceContracts.js";

it(
  "delivers guidance results the validating SDK client accepts over the stdio server",
  { timeout: 60_000 },
  async () => {
    const client = new Client({ name: "guidance-stdio-test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      stderr: "pipe",
    });
    await client.connect(transport);
    try {
      // Loading the live definitions makes the SDK validate every result
      // against the advertised, SDK-converted output schema.
      const advertised = (await client.listTools()).tools.filter(({ name }) =>
        ["search_guidance", "read_guidance_section"].includes(name),
      );
      expect(advertised.map(({ outputSchema }) => outputSchema?.type)).toEqual([
        "object",
        "object",
      ]);
      const found = await client.callTool({
        name: "search_guidance",
        arguments: { query: "exact JavaScript module", limit: 1 },
      });
      expect(found.isError).not.toBe(true);
      const search = searchGuidanceToolOutputSchema.parse(
        found.structuredContent,
      ).result;
      if (search.status !== "matches")
        throw new Error("Expected guidance matches");
      const locator = search.matches[0]?.locator;
      const read = await client.callTool({
        name: "read_guidance_section",
        arguments: { locator },
      });
      expect(
        readGuidanceSectionToolOutputSchema.parse(read.structuredContent)
          .result,
      ).toMatchObject({ status: "section", locator });
      const none = await client.callTool({
        name: "search_guidance",
        arguments: { query: "qzxv-unlikely-guidance-term" },
      });
      expect(
        searchGuidanceToolOutputSchema.parse(none.structuredContent).result,
      ).toMatchObject({ status: "no_matches", total_matches: 0 });
    } finally {
      await client.close();
    }
  },
);
