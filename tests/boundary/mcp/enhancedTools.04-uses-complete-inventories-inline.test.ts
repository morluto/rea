import { afterEach, describe, expect, it } from "vitest";

import {
  closeEnhancedToolResources,
  connect,
  jsonResult,
} from "./enhancedToolsHarness.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";

afterEach(closeEnhancedToolResources);

describe("enhanced MCP tools", () => {
  it("discovers every Objective-C class from one complete inventory", async () => {
    const client = await connect({
      execute: (name) => {
        expect(name).toBe("list_names");
        return Promise.resolve(
          ok([
            { address: "0x1", value: "_OBJC_CLASS_$_First" },
            { address: "0x2", value: "_OBJC_CLASS_$_Last" },
          ]),
        );
      },
    });
    const result = jsonResult(
      await client.callTool({ name: "get_objc_classes", arguments: {} }),
    );
    expect(result).toMatchObject({ count: 2 });
  });

  it("returns the complete overview inline with exhaustive totals", async () => {
    const client = await connect({
      execute: (name) => {
        switch (name) {
          case "list_segments":
            return Promise.resolve(
              ok([
                { name: "__TEXT", start: "0x1000", end: "0x1800" },
                { name: "__DATA", start: "0x1800", end: "0x2000" },
              ]),
            );
          case "list_documents":
            return Promise.resolve(ok(["fixture"]));
          case "list_strings":
            return Promise.resolve(
              ok(
                Array.from({ length: 700 }, (_, index) => ({
                  address: `0x${(0x30 + index).toString(16)}`,
                  value: `string-${index}`,
                })),
              ),
            );
          case "list_procedures": {
            return Promise.resolve(
              ok([
                { address: "0x1", value: "first" },
                { address: "0x2", value: "last" },
              ]),
            );
          }
          default:
            return Promise.resolve(ok(null));
        }
      },
    });
    const result = jsonResult(
      await client.callTool({
        name: "binary_overview",
        arguments: {},
      }),
    );
    expect(result).toEqual({
      document: "fixture",
      segments: [
        { name: "__TEXT", start: "0x1000", end: "0x1800", length: 2048 },
        { name: "__DATA", start: "0x1800", end: "0x2000", length: 2048 },
      ],
      segment_count: 2,
      procedure_count: 2,
      string_count: 700,
    });
  });

  it("rejects paginated provider output", async () => {
    const client = await connect({
      execute: () =>
        Promise.resolve(
          ok({
            items: [{ address: "0x1", value: "_TtC5First" }],
          }),
        ),
    });
    const result = await client.callTool({
      name: "analyze_swift_types",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = result.content.find((item) => item.type === "text");
    expect(text?.type === "text" ? text.text : "").toBe(
      JSON.stringify(result.structuredContent),
    );
  });
});
