import { describe, expect, it } from "vitest";

import {
  formatSuggestedToolNames,
  suggestToolNames,
} from "./toolNameSuggestions.js";

const CANDIDATES = [
  "search_procedures",
  "search_bytes",
  "list_procedures",
  "list_names",
  "find_xrefs_to_name",
  "xrefs",
  "open_binary",
  "binary_session",
  "discover_tools",
  "annotate_native_function",
] as const;

describe("suggestToolNames", () => {
  it("suggests the nearest name for a one-character typo", () => {
    expect(suggestToolNames("search_procedure", CANDIDATES)).toEqual([
      "search_procedures",
    ]);
    expect(suggestToolNames("list_procedure", CANDIDATES)).toEqual([
      "list_procedures",
    ]);
  });

  it("names a cold tool as itself so discovery can load it", () => {
    expect(suggestToolNames("find_xrefs_to_name", CANDIDATES)).toEqual([
      "find_xrefs_to_name",
    ]);
  });

  it("reaches a longer name from a token prefix", () => {
    expect(suggestToolNames("find_xref", CANDIDATES)).toEqual([
      "find_xrefs_to_name",
    ]);
    expect(suggestToolNames("xrefs", CANDIDATES)).toEqual([
      "xrefs",
      "find_xrefs_to_name",
    ]);
  });

  it("returns up to three names, nearest first", () => {
    expect(suggestToolNames("search", CANDIDATES)).toEqual([
      "search_bytes",
      "search_procedures",
    ]);
  });

  it("suggests nothing for an unrelated name", () => {
    expect(suggestToolNames("totally_unknown_tool", CANDIDATES)).toEqual([]);
    expect(suggestToolNames("", CANDIDATES)).toEqual([]);
  });
});

describe("formatSuggestedToolNames", () => {
  it("joins one, two, and three names", () => {
    expect(formatSuggestedToolNames(["a"])).toBe("a");
    expect(formatSuggestedToolNames(["a", "b"])).toBe("a or b");
    expect(formatSuggestedToolNames(["a", "b", "c"])).toBe("a, b, or c");
  });
});
