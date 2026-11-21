import { describe, expect, it } from "vitest";
import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";
import {
  binaryNinjaPageSchema,
  binaryNinjaMemoryReadSchema,
  parseBinaryNinjaCodeBlock,
  parseBinaryNinjaDocument,
  parseBinaryNinjaFunctionReferences,
  parseBinaryNinjaTable,
} from "./BinaryNinjaProtocolValues.js";

// Captured from Binary Ninja 6.0.10601's GUI MCP server (binaryninja_ui_mcp 0.1.0).
const STRING_PAGE = `---
tool: "bn_string_list"
query: "|"
previewBytes: 64
offset: 0
limit: 2
count: 2
total: 104
nextOffset: 2
truncated: true
---

| string | type | length | previewEscaped | previewHex | previewTruncated |
| --- | --- | --- | --- | --- | --- |
| 0x140001a22 | AsciiString | 0x4 | \\|$0A | 7c243041 | false |
| 0x14000141c | AsciiString | 0x4 | \\\\$XH | 5c245848 | false |
`;

describe("Binary Ninja rendered replies", () => {
  it("parses front matter as JSON scalars and checks the producing tool", () => {
    const document = parseBinaryNinjaDocument(STRING_PAGE, "bn_string_list");
    expect(binaryNinjaPageSchema.parse(document.metadata)).toMatchObject({
      offset: 0,
      count: 2,
      total: 104,
      nextOffset: 2,
      truncated: true,
    });
    expect(document.metadata.query).toBe("|");
    expect(() =>
      parseBinaryNinjaDocument(STRING_PAGE, "bn_function_list"),
    ).toThrow(AnalysisProtocolError);
    expect(() =>
      parseBinaryNinjaDocument(
        "---\ntool: bn_string_list\n---\n",
        "bn_string_list",
      ),
    ).toThrow(AnalysisProtocolError);
  });

  it("unescapes cell pipes and keeps backslashes, which the producer does not escape", () => {
    const { body } = parseBinaryNinjaDocument(STRING_PAGE, "bn_string_list");
    const rows = parseBinaryNinjaTable(
      body,
      [
        "string",
        "type",
        "length",
        "previewEscaped",
        "previewHex",
        "previewTruncated",
      ],
      "bn_string_list",
    );
    expect(rows.map((row) => row.previewEscaped)).toEqual(["|$0A", "\\\\$XH"]);
  });

  it("keeps empty cells and rejects reordered columns or ragged rows", () => {
    const body =
      "| Callsite | Architecture | Callee Address | Callee Functions |\n| --- | --- | --- | --- |\n| 0x14000ae2d | x86_64 | 0x140026930 |  |\n";
    const columns = [
      "Callsite",
      "Architecture",
      "Callee Address",
      "Callee Functions",
    ];
    expect(parseBinaryNinjaTable(body, columns, "bn_function_callees")).toEqual(
      [
        {
          Callsite: "0x14000ae2d",
          Architecture: "x86_64",
          "Callee Address": "0x140026930",
          "Callee Functions": "",
        },
      ],
    );
    expect(() =>
      parseBinaryNinjaTable(
        body,
        [...columns].reverse(),
        "bn_function_callees",
      ),
    ).toThrow(AnalysisProtocolError);
    expect(() =>
      parseBinaryNinjaTable(
        body.replace("|  |\n", "|\n"),
        columns,
        "bn_function_callees",
      ),
    ).toThrow(AnalysisProtocolError);
  });

  it("rejects inconsistent pagination", () => {
    expect(
      binaryNinjaPageSchema.safeParse({
        offset: 0,
        count: 2,
        total: 9,
        nextOffset: 3,
        truncated: true,
      }).success,
    ).toBe(false);
    expect(
      binaryNinjaPageSchema.safeParse({
        offset: 0,
        count: 2,
        total: 9,
        nextOffset: null,
        truncated: true,
      }).success,
    ).toBe(false);
  });

  it("extracts exactly one fenced code block of the expected language", () => {
    const body = "\n````bn-pseudoc\n  int64_t f()\n\n{\n}\n````\n";
    expect(parseBinaryNinjaCodeBlock(body, ["bn-pseudoc"], "t")).toEqual([
      "  int64_t f()",
      "",
      "{",
      "}",
    ]);
    expect(() => parseBinaryNinjaCodeBlock(body, ["asm"], "t")).toThrow(
      AnalysisProtocolError,
    );
    expect(() =>
      parseBinaryNinjaCodeBlock("````asm\n0x1  ret\n", ["asm"], "t"),
    ).toThrow(AnalysisProtocolError);
  });

  it("parses function references whose names contain commas and parentheses", () => {
    expect(
      parseBinaryNinjaFunctionReferences(
        "operator()(int, int) (0x1400 (x86_64)), f, g (0x1500 (thumb2))",
        "t",
      ),
    ).toEqual([
      {
        name: "operator()(int, int)",
        address: "0x1400",
        architecture: "x86_64",
      },
      { name: "f, g", address: "0x1500", architecture: "thumb2" },
    ]);
    expect(parseBinaryNinjaFunctionReferences("", "t")).toEqual([]);
    expect(() => parseBinaryNinjaFunctionReferences("main", "t")).toThrow(
      AnalysisProtocolError,
    );
  });
});

it.each([
  { bytesRead: 2, hex: "41" },
  { bytesRead: 1, hex: "4142" },
  { bytesRead: 1, hex: "" },
])("rejects memory replies with inconsistent hex length: %j", (read) => {
  expect(
    binaryNinjaMemoryReadSchema.safeParse({ address: "0x500000", ...read })
      .success,
  ).toBe(false);
});
it.each([
  { bytesRead: 0, hex: "" },
  { bytesRead: 2, hex: "41FF" },
])("accepts memory replies with exact byte counts: %j", (read) => {
  expect(
    binaryNinjaMemoryReadSchema.safeParse({ address: "0x500000", ...read })
      .success,
  ).toBe(true);
});

it.each([
  { offset: 0, count: 1, total: 2, nextOffset: null, truncated: false },
  { offset: 1, count: 2, total: 2, nextOffset: null, truncated: false },
  { offset: 0, count: 2, total: 2, nextOffset: 2, truncated: true },
])("rejects inconsistent terminal page coverage: %j", (page) => {
  expect(binaryNinjaPageSchema.safeParse(page).success).toBe(false);
});
it.each([
  { offset: 0, count: 0, total: 0, nextOffset: null, truncated: false },
  { offset: 1, count: 1, total: 2, nextOffset: null, truncated: false },
])("accepts exact terminal coverage: %j", (page) => {
  expect(binaryNinjaPageSchema.safeParse(page).success).toBe(true);
});
