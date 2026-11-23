import { describe, expect, it } from "vitest";
import {
  pageListingItems,
  parsedListingExecution,
} from "./AdbOperationResults.js";

const provider = { id: "adb", name: "ADB", version: "1.0" };
const noUnparsed = { sample: [], total: 0 };

describe("pageListingItems", () => {
  it("returns all items unchanged with no limitations when paging is omitted", () => {
    const page = pageListingItems(["a", "b", "c"], "packages", {});
    expect(page).toEqual({
      items: ["a", "b", "c"],
      truncated: false,
      limitations: [],
    });
  });

  it("slices by offset and limit and reports partial coverage", () => {
    const page = pageListingItems(["a", "b", "c", "d"], "packages", {
      offset: 1,
      limit: 2,
    });
    expect(page.items).toEqual(["b", "c"]);
    expect(page.truncated).toBe(true);
    expect(page.limitations).toEqual([
      "Returned 2 of 4 packages (offset 1, limit 2); adjust offset or limit to read remaining entries.",
    ]);

    const execution = parsedListingExecution(
      { packages: page.items },
      noUnparsed,
      provider,
      page.limitations,
      page.truncated,
    );
    expect((execution.result as { readonly coverage: string }).coverage).toBe(
      "partial",
    );
    expect(execution.limitations).toEqual(page.limitations);
  });

  it("does not mark truncated when limit covers the full list from offset 0", () => {
    const page = pageListingItems(["a", "b"], "processes", { limit: 10 });
    expect(page).toEqual({
      items: ["a", "b"],
      truncated: false,
      limitations: [],
    });
  });
});
