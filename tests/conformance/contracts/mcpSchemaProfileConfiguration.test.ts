import { expect, it } from "vitest";

import { parseConfig } from "../../../src/config/parseConfig.js";

it.each(["off", "compact"] as const)(
  "admits compact input and %s output in process configuration",
  (output) => {
    const parsed = parseConfig({
      REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
      REA_MCP_OUTPUT_SCHEMA_PROFILE: output,
    });
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.mcpOutputSchemaProfile).toBe(output);
  },
);

const input = "REA_MCP_INPUT_SCHEMA_PROFILE";
const output = "REA_MCP_OUTPUT_SCHEMA_PROFILE";
const unsupported = ["full", "", "COMPACT", "compact "];

it.each([
  ...unsupported.map((value) => ({
    setting: input,
    value,
    profiles: /compact/u,
  })),
  ...unsupported.map((value) => ({
    setting: output,
    value,
    profiles: /off.*compact/u,
  })),
  { setting: input, value: "off", profiles: /compact/u },
])(
  "rejects $setting=$value in process configuration",
  ({ setting, value, profiles }) => {
    const parsed = parseConfig({ [setting]: value });
    expect(parsed).toMatchObject({
      ok: false,
      error: {
        settings: [{ setting, constraint: expect.stringMatching(profiles) }],
      },
    });
  },
);
