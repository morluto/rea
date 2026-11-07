import { constants } from "node:buffer";
import { expect, it } from "vitest";
import { parseConfig } from "./parseConfig.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  DEFAULT_PROCESS_TABLE_MAX_BYTES,
  parseProcessTableMaxBytes,
  PROCESS_TABLE_MAX_BYTES_SETTING,
} from "./processTableOutputBudget.js";

it("keeps the whole-host table default separate from firmware diagnostics", () => {
  expect(parseProcessTableMaxBytes(undefined)).toEqual({
    ok: true,
    value: DEFAULT_PROCESS_TABLE_MAX_BYTES,
  });
  expect(DEFAULT_PROCESS_TABLE_MAX_BYTES).toBe(8 * 1024 * 1024);
});

it.each(["1", "65536", "16777216", String(constants.MAX_STRING_LENGTH)])(
  "accepts the selected table allowance %s at config admission",
  (value) => {
    expect(parseProcessTableMaxBytes(value)).toEqual({
      ok: true,
      value: Number(value),
    });
    expect(parseConfig({ [PROCESS_TABLE_MAX_BYTES_SETTING]: value }).ok).toBe(
      true,
    );
  },
);

it.each([
  "",
  "0",
  "-1",
  "1.5",
  " ",
  " 100",
  "1e3",
  "0x100",
  "Infinity",
  "9007199254740993",
  String(constants.MAX_STRING_LENGTH + 1),
])(
  "rejects invalid table allowance %j with actionable configuration facts",
  (value) => {
    const parsed = parseProcessTableMaxBytes(value);
    expect(parsed.ok).toBe(false);
    const config = parseConfig({ [PROCESS_TABLE_MAX_BYTES_SETTING]: value });
    if (config.ok)
      throw new Error("Expected invalid process-table configuration");
    expect(projectAnalysisError(config.error)).toMatchObject({
      code: "configuration_invalid",
      details: {
        settings: [
          {
            setting: PROCESS_TABLE_MAX_BYTES_SETTING,
            constraint: expect.any(String),
          },
        ],
      },
    });
  },
);
