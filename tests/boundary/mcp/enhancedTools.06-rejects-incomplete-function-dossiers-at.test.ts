import { afterEach, describe, expect, it } from "vitest";

import { functionDossierSchema } from "../../../src/domain/hopperValues.js";
import { ghidraFunctionDossier } from "../../../src/domain/ghidraValues.fixture.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { closeEnhancedToolResources, connect } from "./enhancedToolsHarness.js";

afterEach(closeEnhancedToolResources);

describe("analyze_function MCP producer validation", () => {
  it("rejects an incomplete function dossier", async () => {
    const client = await connect({
      execute: () =>
        Promise.resolve(
          observed({
            procedure: { address: "0x1", name: "entry" },
            pseudocode: { text: "plausible but incomplete" },
          }),
        ),
    });
    const result = await client.callTool({
      name: "analyze_function",
      arguments: { procedure: "0x1" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual({
      type: "text",
      text: JSON.stringify(result.structuredContent),
    });
  });

  it("rejects a malformed collection in an otherwise complete dossier", async () => {
    const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
    const client = await connect({
      execute: () =>
        Promise.resolve(
          observed({
            ...dossier,
            comments: {
              items: [],
              total: 0,
              returned: 1,
              truncated: false,
              next_offset: null,
            },
          }),
        ),
    });
    const result = await client.callTool({
      name: "analyze_function",
      arguments: { procedure: "0x1" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual({
      type: "text",
      text: JSON.stringify(result.structuredContent),
    });
  });
});
