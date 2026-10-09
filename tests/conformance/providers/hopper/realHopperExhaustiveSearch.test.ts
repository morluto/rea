import { describe, expect, it } from "vitest";

import { openAndVerifyLargeFixture } from "../../../../scripts/lib/real-hopper-exhaustive-search.mjs";

const normalize = (value: unknown): unknown => value;

describe("Hopper search verifier rejection", () => {
  it.each(["duplicate", "missing"] as const)(
    "rejects %s positive evidence",
    async (fault) => {
      await expect(
        openAndVerifyLargeFixture({
          client: fixtureClient(3, fault),
          options: {},
          normalizedResult: normalize,
          path: "/fixture",
          expectedCount: 3,
          symbolPrefix: "_rea_fixture_",
          stringPrefix: "REA_FIXTURE_",
        }),
      ).rejects.toThrow();
    },
  );
});

const fixtureClient = (count: number, fault: "duplicate" | "missing") => {
  return {
    callTool: async (request: unknown) => {
      if (
        typeof request !== "object" ||
        request === null ||
        !("name" in request)
      )
        throw new Error("Missing fixture operation");
      const operation = request.name;
      if (operation === "open_binary") return { isError: false };
      if (operation !== "search_procedures" && operation !== "search_strings")
        throw new Error(`Unsupported fixture operation: ${String(operation)}`);
      const procedures = operation === "search_procedures";
      const items = Array.from({ length: count }, (_, index) => {
        const duplicateIndex = fault === "duplicate" && index === 1 ? 0 : index;
        return {
          address: `0x${(0x1000 + index).toString(16)}`,
          value: `${procedures ? "_rea_fixture_" : "REA_FIXTURE_"}${String(duplicateIndex).padStart(4, "0")}`,
        };
      });
      if (fault === "missing") items.pop();
      return items;
    },
  };
};
