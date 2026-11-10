import { describe, expect, it } from "vitest";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  DEFAULT_NTFS_MFT_MAX_FILE_BYTES,
  MAXIMUM_NTFS_MFT_MAX_FILE_BYTES,
  MINIMUM_NTFS_MFT_MAX_FILE_BYTES,
  NTFS_MFT_MAX_FILE_SETTING,
} from "../domain/windows/ntfsMft.js";
import { parseEnvironment } from "./environment.js";
import {
  NTFS_MFT_FILE_ADMISSION_CONSTRAINT,
  parseNtfsMftFileAdmission,
} from "./ntfsMftFileAdmission.js";

const rejectedSetting = {
  setting: NTFS_MFT_MAX_FILE_SETTING,
  constraint: NTFS_MFT_FILE_ADMISSION_CONSTRAINT,
};

describe("NTFS $MFT file admission", () => {
  it("keeps the 512 MiB default when the setting is unset", () => {
    expect(parseNtfsMftFileAdmission(undefined)).toEqual({
      ok: true,
      value: {
        maximumBytes: DEFAULT_NTFS_MFT_MAX_FILE_BYTES,
        source: "default",
      },
    });
    expect(DEFAULT_NTFS_MFT_MAX_FILE_BYTES).toBe(512 * 1024 * 1024);
  });

  it("accepts a decimal ceiling at the floor, the default, and the maximum", () => {
    for (const maximumBytes of [
      MINIMUM_NTFS_MFT_MAX_FILE_BYTES,
      DEFAULT_NTFS_MFT_MAX_FILE_BYTES,
      MAXIMUM_NTFS_MFT_MAX_FILE_BYTES,
    ]) {
      expect(parseNtfsMftFileAdmission(String(maximumBytes))).toEqual({
        ok: true,
        value: { maximumBytes, source: "setting" },
      });
    }
  });

  it.each([
    "0",
    String(MINIMUM_NTFS_MFT_MAX_FILE_BYTES - 1),
    String(MAXIMUM_NTFS_MFT_MAX_FILE_BYTES + 1),
    "0x100",
    "1e6",
    "512m",
    `0${String(DEFAULT_NTFS_MFT_MAX_FILE_BYTES)}`,
  ])("refuses %j as a launch value", (value) => {
    const parsed = parseNtfsMftFileAdmission(value);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.settings).toEqual([rejectedSetting]);
    expect(projectAnalysisError(parsed.error)).toMatchObject({
      code: "configuration_invalid",
      details: { settings: [rejectedSetting] },
    });
    const startup = parseEnvironment({ [NTFS_MFT_MAX_FILE_SETTING]: value });
    expect(startup.ok).toBe(false);
    if (startup.ok) return;
    expect(startup.error.settings).toEqual([rejectedSetting]);
  });
});
