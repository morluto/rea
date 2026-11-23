import { expect, it } from "vitest";

import { parseConfig } from "../../../src/config/parseConfig.js";
import { TOOL_FAMILY_IDS } from "../../../src/contracts/toolFamilyIds.js";

it("normalizes a selected family scope in caller order", () => {
  const parsed = parseConfig({
    REA_MCP_TOOL_FAMILIES: " session , application ,session ",
  });
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.mcpToolFamilies).toEqual(["session", "application"]);
});

it("admits all declared families together", () => {
  const parsed = parseConfig({
    REA_MCP_TOOL_FAMILIES: TOOL_FAMILY_IDS.join(","),
  });
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.mcpToolFamilies).toEqual(TOOL_FAMILY_IDS);
});

it.each(["", " , ", "session,typo", "SESSION", "all"])(
  "rejects unknown or empty scopes in process configuration: %j",
  (value) => {
    expect(parseConfig({ REA_MCP_TOOL_FAMILIES: value })).toMatchObject({
      ok: false,
      error: {
        settings: [{ setting: "REA_MCP_TOOL_FAMILIES" }],
      },
    });
  },
);
