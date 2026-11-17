import { describe, expect, it } from "vitest";

import { parseMcpOutputSchemaProfile } from "../../../src/config/mcpOutputSchemaProfile.js";
import { parseConfig } from "../../../src/config/parseConfig.js";

describe("MCP output schema profile configuration", () => {
  it("accepts the off and compact presentations", () => {
    expect(parseMcpOutputSchemaProfile(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    for (const value of ["compact", "off"] as const)
      expect(parseMcpOutputSchemaProfile(value)).toEqual({
        ok: true,
        value,
      });
  });

  // `full` was removed; a registration that still selects it fails closed.
  it.each(["full", "", "FULL", "compact ", "off ", "minimal", "0"])(
    "rejects unsupported profiles: %j",
    (value) => {
      const parsed = parseMcpOutputSchemaProfile(value);
      if (parsed.ok) throw new Error("Expected invalid profile");
      expect(parsed.error.settings).toEqual([
        {
          setting: "REA_MCP_OUTPUT_SCHEMA_PROFILE",
          constraint: expect.any(String),
        },
      ]);
    },
  );

  it("refuses the removed full profile at server configuration", () => {
    const parsed = parseConfig({ REA_MCP_OUTPUT_SCHEMA_PROFILE: "full" });
    if (parsed.ok) throw new Error("Expected the removed profile to fail");
    expect(parsed.error.settings).toEqual([
      expect.objectContaining({ setting: "REA_MCP_OUTPUT_SCHEMA_PROFILE" }),
    ]);
  });
});
