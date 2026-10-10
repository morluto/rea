import { describe, expect, it } from "vitest";

import { parseMcpInputSchemaProfile } from "../../../src/config/mcpInputSchemaProfile.js";

describe("MCP input schema profile configuration", () => {
  it("accepts the full and compact presentations", () => {
    expect(parseMcpInputSchemaProfile(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(parseMcpInputSchemaProfile("full")).toEqual({
      ok: true,
      value: "full",
    });
    expect(parseMcpInputSchemaProfile("compact")).toEqual({
      ok: true,
      value: "compact",
    });
  });

  it.each(["", "FULL", "compact ", "minimal", "0"])(
    "rejects unknown profiles: %j",
    (value) => {
      const parsed = parseMcpInputSchemaProfile(value);
      if (parsed.ok) throw new Error("Expected invalid profile");
      expect(parsed.error.message).toContain("REA_MCP_INPUT_SCHEMA_PROFILE");
    },
  );
});
