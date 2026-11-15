import { describe, expect, it } from "vitest";

import { parseMcpInputSchemaProfile } from "../../../src/config/mcpInputSchemaProfile.js";
import { parseConfig } from "../../../src/config/parseConfig.js";

describe("MCP input schema profile configuration", () => {
  it("accepts only the compact presentation", () => {
    expect(parseMcpInputSchemaProfile(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(parseMcpInputSchemaProfile("compact")).toEqual({
      ok: true,
      value: "compact",
    });
  });

  // `full` was removed; a registration that still selects it fails closed.
  it.each(["full", "", "FULL", "compact ", "minimal", "0"])(
    "rejects unsupported profiles: %j",
    (value) => {
      const parsed = parseMcpInputSchemaProfile(value);
      if (parsed.ok) throw new Error("Expected invalid profile");
      expect(parsed.error.settings).toEqual([
        {
          setting: "REA_MCP_INPUT_SCHEMA_PROFILE",
          constraint: expect.any(String),
        },
      ]);
    },
  );

  it("refuses the removed full profile at server configuration", () => {
    const parsed = parseConfig({ REA_MCP_INPUT_SCHEMA_PROFILE: "full" });
    if (parsed.ok) throw new Error("Expected the removed profile to fail");
    expect(parsed.error.settings).toEqual([
      expect.objectContaining({ setting: "REA_MCP_INPUT_SCHEMA_PROFILE" }),
    ]);
  });
});
