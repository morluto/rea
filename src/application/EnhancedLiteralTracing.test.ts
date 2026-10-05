import { describe, expect, it } from "vitest";

import { ok } from "../domain/result.js";
import { traceLiteralFeature } from "./EnhancedLiteralTracing.js";

describe("literal feature tracing", () => {
  it("returns matched procedure and string facts with references", async () => {
    const result = await traceLiteralFeature(
      async (name) => {
        if (name === "search_strings")
          return ok([{ address: "0x1000", value: "launch feature" }]);
        if (name === "search_procedures")
          return ok([{ address: "0x2000", value: "launchFeature" }]);
        if (name === "xrefs") return ok([]);
        if (name === "resolve_containing_procedure") return ok(null);
        throw new Error(`Unexpected analysis call: ${name}`);
      },
      { query: "launch feature", case_sensitive: false },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        matches: [
          { type: "string", address: "0x1000", value: "launch feature" },
          { type: "procedure", address: "0x2000", value: "launchFeature" },
        ],
        references: [],
      },
    });
  });
});
