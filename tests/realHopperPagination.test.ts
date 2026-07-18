import { describe, expect, it } from "vitest";

import { verifyLargeFixturePagination } from "../scripts/lib/real-hopper-pagination.mjs";

const normalize = (value: unknown): unknown => value;

describe("real Hopper large-fixture pagination", () => {
  it("proves every procedure and string across exact search pages", async () => {
    await expect(
      verifyLargeFixturePagination({
        client: fixtureClient(205),
        options: {},
        normalizedResult: normalize,
        expectedCount: 205,
        symbolPrefix: "_rea_page_",
        stringPrefix: "REA_PAGE_",
      }),
    ).resolves.toEqual({
      procedures: { count: 205, pages: 3 },
      strings: { count: 205, pages: 3 },
    });
  });

  it.each(["truncated", "duplicate", "wrong-total"] as const)(
    "rejects %s positive evidence",
    async (fault) => {
      await expect(
        verifyLargeFixturePagination({
          client: fixtureClient(205, fault),
          options: {},
          normalizedResult: normalize,
          expectedCount: 205,
          symbolPrefix: "_rea_page_",
          stringPrefix: "REA_PAGE_",
        }),
      ).rejects.toThrow();
    },
  );
});

const fixtureClient = (
  count: number,
  fault?: "truncated" | "duplicate" | "wrong-total",
) => ({
  callTool: async (request: unknown) => {
    const parsed = request as {
      name: string;
      arguments: { offset: number; limit: number };
    };
    const { offset, limit } = parsed.arguments;
    const returned = Math.min(limit, count - offset);
    const procedure = parsed.name === "search_procedures";
    const items = Array.from({ length: returned }, (_, pageIndex) => {
      const index = offset + pageIndex;
      const evidenceIndex = fault === "duplicate" && index === 1 ? 0 : index;
      return {
        address: `0x${(0x1000 + index).toString(16)}`,
        value: `${procedure ? "_rea_page_" : "REA_PAGE_"}${String(evidenceIndex).padStart(4, "0")}`,
        value_truncated: fault === "truncated" && index === 0,
      };
    });
    const next = offset + returned < count ? offset + returned : null;
    return {
      items,
      offset,
      limit,
      total: fault === "wrong-total" ? count + 1 : count,
      next_offset: next,
      has_more: next !== null,
    };
  },
});
