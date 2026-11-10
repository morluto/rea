import { describe, expect, it } from "vitest";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  DEFAULT_REGF_MAX_FILE_BYTES,
  MAXIMUM_REGF_MAX_FILE_BYTES,
  MINIMUM_REGF_MAX_FILE_BYTES,
  REGF_HIVE_MAX_FILE_SETTING,
} from "../domain/windows/registryHive.js";
import { parseEnvironment } from "./environment.js";
import {
  parseRegfHiveFileAdmission,
  REGF_HIVE_FILE_ADMISSION_CONSTRAINT,
} from "./regfHiveFileAdmission.js";

const rejectedSetting = {
  setting: REGF_HIVE_MAX_FILE_SETTING,
  constraint: REGF_HIVE_FILE_ADMISSION_CONSTRAINT,
};

describe("registry hive file admission", () => {
  it("keeps the 512 MiB default when the setting is unset", () => {
    expect(parseRegfHiveFileAdmission(undefined)).toEqual({
      ok: true,
      value: {
        maximumBytes: DEFAULT_REGF_MAX_FILE_BYTES,
        source: "default",
      },
    });
    expect(DEFAULT_REGF_MAX_FILE_BYTES).toBe(512 * 1024 * 1024);
  });

  it("accepts a decimal ceiling at the floor, the default, and the maximum", () => {
    for (const maximumBytes of [
      MINIMUM_REGF_MAX_FILE_BYTES,
      DEFAULT_REGF_MAX_FILE_BYTES,
      MAXIMUM_REGF_MAX_FILE_BYTES,
    ]) {
      expect(parseRegfHiveFileAdmission(String(maximumBytes))).toEqual({
        ok: true,
        value: { maximumBytes, source: "setting" },
      });
    }
  });

  it.each([
    "0",
    String(MINIMUM_REGF_MAX_FILE_BYTES - 1),
    String(MAXIMUM_REGF_MAX_FILE_BYTES + 1),
    "0x1000",
    "1e6",
    "512m",
    `0${String(DEFAULT_REGF_MAX_FILE_BYTES)}`,
  ])("refuses %j as a launch value", (value) => {
    const parsed = parseRegfHiveFileAdmission(value);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.settings).toEqual([rejectedSetting]);
    expect(projectAnalysisError(parsed.error)).toMatchObject({
      code: "configuration_invalid",
      details: { settings: [rejectedSetting] },
    });
    const startup = parseEnvironment({ [REGF_HIVE_MAX_FILE_SETTING]: value });
    expect(startup.ok).toBe(false);
    if (startup.ok) return;
    expect(startup.error.settings).toEqual([rejectedSetting]);
  });
});
