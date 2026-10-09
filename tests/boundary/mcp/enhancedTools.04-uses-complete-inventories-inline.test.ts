import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  closeEnhancedToolResources,
  connect,
  jsonResult,
} from "./enhancedToolsHarness.js";
import type {
  AnalysisExecution,
  AnalysisOperationPort,
} from "../../../src/application/AnalysisProvider.js";
import type { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisProtocolError,
} from "../../../src/domain/analysisErrorCore.js";
import { err, type Result } from "../../../src/domain/result.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";

afterEach(closeEnhancedToolResources);

it("discovers declarations without counting duplicates or compiler bookkeeping", async () => {
  const client = await connect({
    execute: (name) => {
      expect(name).toBe("list_names");
      return Promise.resolve(
        ok([
          { address: "0x1", value: "_OBJC_CLASS_$_First" },
          { address: "0x2", value: "_OBJC_CLASS_$_Last" },
          { address: "0x3", value: "_OBJC_CLASS_$_First" },
          { address: "0x4", value: "__OBJC_CLASS_RO_$_First" },
          { address: "0x5", value: "_OBJC_CLASSLIST_REFERENCES_$_" },
          { address: "0x6", value: "l_OBJC_CLASS_NAME_" },
          { address: "0x7", value: "_OBJC_IVAR_$_First.value" },
          { address: "0x8", value: "_OBJC_METACLASS_$_First" },
          { address: "0x9", value: "_OBJC_PROP_$_First.value" },
          { address: "0xa", value: "__OBJC_PROTOCOL_$_Delegate" },
          { address: "0xb", value: "__OBJC_PROTOCOL_$_Delegate" },
          { address: "0xc", value: "__OBJC_PROTOCOL_REFERENCE_$_Delegate" },
          { address: "0xd", value: "_$s4main7ScoringMp" },
          { address: "0xe", value: "_$s4main7ScoringTL" },
          { address: "0xf", value: "_$s4main7ScoringP5scoreSiyFTq" },
          { address: "0x10", value: "l_OBJC_CLASS_Legacy" },
          { address: "0x11", value: "l_OBJC_CLASS_NAME_.1" },
        ]),
      );
    },
  });
  const result = jsonResult(
    await client.callTool({ name: "get_objc_classes", arguments: {} }),
  );
  expect(result).toMatchObject({
    count: 3,
    classes: [
      { address: "0x1", name: "_OBJC_CLASS_$_First" },
      { address: "0x2", name: "_OBJC_CLASS_$_Last" },
      { address: "0x10", name: "l_OBJC_CLASS_Legacy" },
    ],
  });
  expect(
    jsonResult(
      await client.callTool({
        name: "get_objc_classes",
        arguments: { pattern: "First" },
      }),
    ),
  ).toMatchObject({
    count: 1,
    classes: [{ address: "0x1", name: "_OBJC_CLASS_$_First" }],
  });
  expect(
    jsonResult(
      await client.callTool({ name: "get_objc_protocols", arguments: {} }),
    ),
  ).toMatchObject({
    count: 2,
    protocols: [
      { address: "0xa", name: "__OBJC_PROTOCOL_$_Delegate" },
      { address: "0xd", name: "_$s4main7ScoringMp" },
    ],
  });
});

describe("enhanced MCP tools", () => {
  it("returns the complete overview inline with exhaustive totals", async () => {
    const client = await connect({
      execute: (name) => {
        switch (name) {
          case "list_segments":
            return Promise.resolve(
              ok([
                {
                  name: "__TEXT",
                  start: "0x1000",
                  end: "0x1800",
                  readable: null,
                  writable: null,
                  executable: null,
                },
                {
                  name: "__DATA",
                  start: "0x1800",
                  end: "0x2000",
                  readable: null,
                  writable: null,
                  executable: null,
                },
              ]),
            );
          case "current_document":
            return Promise.resolve(ok("fixture"));
          case "list_documents":
            return Promise.resolve(ok(["New Document", "fixture"]));
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
      JSON.stringify(parseMcpToolError(result)),
    );
  });

  it("rejects a segment with omitted coordinates instead of reporting zero length", async () => {
    const client = await connect({
      execute: (name) =>
        Promise.resolve(
          name === "list_segments"
            ? ok([
                {
                  name: "__TEXT",
                  end: "0x2000",
                  readable: null,
                  writable: null,
                  executable: null,
                },
              ])
            : ok(name === "current_document" ? "fixture" : []),
        ),
    });
    const result = await client.callTool({
      name: "binary_overview",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual({
      type: "text",
      text: JSON.stringify(parseMcpToolError(result)),
    });
  });
});

const overviewPort = (
  current: Result<AnalysisExecution, AnalysisError>,
  documents: readonly string[],
): AnalysisOperationPort => ({
  execute: (name) => {
    switch (name) {
      case "current_document":
        return Promise.resolve(current);
      case "list_documents":
        return Promise.resolve(ok([...documents]));
      case "list_segments":
        return Promise.resolve(
          ok([
            {
              name: "text",
              start: "0x1000",
              end: "0x2000",
              readable: null,
              writable: null,
              executable: null,
            },
          ]),
        );
      default:
        return Promise.resolve(ok([]));
    }
  },
});

describe("overview document identity through MCP", () => {
  const unsupported = () =>
    err(
      new AnalysisCapabilityUnavailableError(
        "fixture",
        "current_document",
        "headless provider",
      ),
    );

  it("uses the sole headless document when current-document selection is unsupported", async () => {
    const client = await connect(
      overviewPort(unsupported(), ["single-target"]),
    );
    expect(
      jsonResult(
        await client.callTool({ name: "binary_overview", arguments: {} }),
      ),
    ).toMatchObject({ document: "single-target" });
  });

  it.each([
    { documents: [] },
    { documents: [""] },
    { documents: ["one", "two"] },
  ])(
    "rejects ambiguous or missing headless identities: $documents",
    async ({ documents }) => {
      const client = await connect(overviewPort(unsupported(), documents));
      expect(
        (await client.callTool({ name: "binary_overview", arguments: {} }))
          .isError,
      ).toBe(true);
    },
  );

  it.each([{ value: null }, { value: "" }, { value: [] }])(
    "rejects a malformed current-document result: $value",
    async ({ value }) => {
      const client = await connect(
        overviewPort(ok(value), ["fallback-must-not-hide-error"]),
      );
      expect(
        (await client.callTool({ name: "binary_overview", arguments: {} }))
          .isError,
      ).toBe(true);
    },
  );

  it("preserves non-capability current-document failures", async () => {
    const client = await connect(
      overviewPort(
        err(new AnalysisProtocolError("failed current-document transport")),
        ["must-not-be-selected"],
      ),
    );
    expect(
      (await client.callTool({ name: "binary_overview", arguments: {} }))
        .isError,
    ).toBe(true);
  });
});
