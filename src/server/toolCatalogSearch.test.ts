import { describe, expect, it } from "vitest";
import {
  createSearchableCatalogTool,
  formatUnknownMcpToolMessage,
  rankCatalogToolMatches,
  suggestAdvertisedTools,
  type AdvertisedToolDescriptor,
} from "./toolCatalogSearch.js";

const SAMPLE_CATALOG: readonly AdvertisedToolDescriptor[] = [
  {
    name: "procedure_pseudo_code",
    description:
      "Decompile one analyzed procedure by symbol or hexadecimal address.",
  },
  {
    name: "batch_decompile",
    description: "Decompile multiple procedures in one call.",
  },
  {
    name: "decompile_all",
    description: "Decompile every procedure into an output directory.",
  },
  {
    name: "import_managed_reconstruction",
    description: "Import a managed decompiler reconstruction.",
  },
  {
    name: "open_binary",
    description: "Open a local executable target.",
  },
  {
    name: "find_xrefs_to_name",
    description: "Find references to a named symbol.",
  },
  {
    name: "undescribed_tool",
  },
];

describe("rankCatalogToolMatches", () => {
  const indexed = SAMPLE_CATALOG.map((tool) =>
    createSearchableCatalogTool(tool.name, tool.description),
  );

  it("lists every tool alphabetically when words are empty in all-word mode", () => {
    expect(rankCatalogToolMatches(indexed, [], "all")).toEqual(
      SAMPLE_CATALOG.map((tool) => tool.name).sort(),
    );
    expect(rankCatalogToolMatches(indexed, [], "any")).toEqual([]);
  });

  it("preserves discover_tools nameScore-then-alphabetical ordering by default", () => {
    expect(rankCatalogToolMatches(indexed, ["decompile"], "all")).toEqual([
      "batch_decompile",
      "decompile_all",
      "import_managed_reconstruction",
      "procedure_pseudo_code",
    ]);
  });

  it("ranks lead-sentence descriptions ahead of mid-sentence mentions only for description-only matches when enabled", () => {
    expect(rankCatalogToolMatches(indexed, ["decompile"], "all", true)).toEqual(
      [
        "batch_decompile",
        "decompile_all",
        "procedure_pseudo_code",
        "import_managed_reconstruction",
      ],
    );
    // Equal nameScore > 0 matches stay alphabetically ordered even when the later name starts with the query verb.
    expect(
      rankCatalogToolMatches(
        [
          createSearchableCatalogTool(
            "decompile_all",
            "Export pseudocode for every procedure.",
          ),
          createSearchableCatalogTool(
            "decompile_jeb_item",
            "Decompile one type or method.",
          ),
        ],
        ["decompile"],
        "all",
        true,
      ),
    ).toEqual(["decompile_all", "decompile_jeb_item"]);
    // Name match must still outrank a lead-sentence description match that sorts earlier alphabetically.
    expect(
      rankCatalogToolMatches(
        [
          createSearchableCatalogTool("alpha_pseudo", "Decompile one target."),
          createSearchableCatalogTool("zebra_decompile", "Run batch work."),
        ],
        ["decompile"],
        "all",
        true,
      ),
    ).toEqual(["zebra_decompile", "alpha_pseudo"]);
  });

  it("ranks any-word fallback by matched word count, then name matches, then alphabetical", () => {
    expect(
      rankCatalogToolMatches(
        indexed,
        ["decompile", "procedure", "missing"],
        "any",
        true,
      ),
    ).toEqual([
      "batch_decompile",
      "decompile_all",
      "procedure_pseudo_code",
      "import_managed_reconstruction",
    ]);
  });
});

describe("suggestAdvertisedTools", () => {
  it("splits unknown names on underscores, hyphens, and whitespace without edit-distance guessing", () => {
    expect(suggestAdvertisedTools("open-binary", SAMPLE_CATALOG)).toEqual([
      "open_binary",
    ]);
    expect(suggestAdvertisedTools("xrefs_name", SAMPLE_CATALOG)).toEqual([
      "find_xrefs_to_name",
    ]);
    // Falls back to any-word matching when no tool matches all words (e.g. "open" matches even when "binry" does not).
    expect(
      suggestAdvertisedTools("decompile_unknown_suffix", SAMPLE_CATALOG),
    ).toEqual([
      "batch_decompile",
      "decompile_all",
      "procedure_pseudo_code",
      "import_managed_reconstruction",
    ]);
    expect(suggestAdvertisedTools("open_binry", SAMPLE_CATALOG)).toEqual([
      "open_binary",
    ]);
    // Single-word typos (even 1 edit away) return no matches because edit distance is not used.
    expect(suggestAdvertisedTools("decomplie", SAMPLE_CATALOG)).toEqual([]);
    expect(suggestAdvertisedTools("opne", SAMPLE_CATALOG)).toEqual([]);
    expect(suggestAdvertisedTools("zzzzzz", SAMPLE_CATALOG)).toEqual([]);
  });

  it("enforces bounds, deduplication, and deterministic slicing", () => {
    expect(suggestAdvertisedTools("", SAMPLE_CATALOG)).toEqual([]);
    expect(suggestAdvertisedTools("___---", SAMPLE_CATALOG)).toEqual([]);
    expect(suggestAdvertisedTools("decompile", SAMPLE_CATALOG, 0)).toEqual([]);
    expect(suggestAdvertisedTools("decompile", SAMPLE_CATALOG, -1)).toEqual([]);
    const oversized = `decompile_${"a".repeat(120)}`; // 130 > 128
    expect(suggestAdvertisedTools(oversized, [{ name: oversized }])).toEqual(
      [],
    );

    const duplicated: readonly AdvertisedToolDescriptor[] = [
      { name: "decompile_z" },
      { name: "decompile_a" },
      { name: "decompile_a" },
      { name: "decompile_m" },
    ];
    expect(suggestAdvertisedTools("decompile", duplicated, 2)).toEqual([
      "decompile_a",
      "decompile_m",
    ]);
  });
});

describe("formatUnknownMcpToolMessage", () => {
  it("formats full-catalog and progressive-catalog messages for zero, one, and multiple matches", () => {
    expect(
      formatUnknownMcpToolMessage("zzzzzz", {
        tools: SAMPLE_CATALOG,
        discoveryAvailable: false,
      }),
    ).toBe(
      "The requested MCP tool is not advertised by this REA server. Call tools/list, select an advertised tool, and retry; do not repeat the unknown tool name.",
    );
    expect(
      formatUnknownMcpToolMessage("open-binary", {
        tools: SAMPLE_CATALOG,
        discoveryAvailable: false,
      }),
    ).toBe(
      "The requested MCP tool is not advertised by this REA server. Closest advertised tool: open_binary. Select an advertised tool or call tools/list, and retry; do not repeat the unknown tool name.",
    );
    expect(
      formatUnknownMcpToolMessage("decompile", {
        tools: SAMPLE_CATALOG,
        discoveryAvailable: false,
      }),
    ).toBe(
      "The requested MCP tool is not advertised by this REA server. Closest advertised tools: batch_decompile, decompile_all, procedure_pseudo_code, import_managed_reconstruction. Select an advertised tool or call tools/list, and retry; do not repeat the unknown tool name.",
    );
    expect(
      formatUnknownMcpToolMessage("zzzzzz", {
        tools: SAMPLE_CATALOG,
        discoveryAvailable: true,
      }),
    ).toBe(
      "The requested MCP tool is not advertised by this REA server. Call discover_tools to find and load an in-scope tool, then retry; do not repeat the unknown tool name.",
    );
    expect(
      formatUnknownMcpToolMessage("open-binary", {
        tools: SAMPLE_CATALOG,
        discoveryAvailable: true,
      }),
    ).toBe(
      "The requested MCP tool is not advertised by this REA server. Closest advertised tool: open_binary. Select an advertised tool or call discover_tools to find and load other in-scope tools, then retry; do not repeat the unknown tool name.",
    );
  });
});
