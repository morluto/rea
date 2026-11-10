import { describe, expect, it } from "vitest";

import { AnalysisSettings } from "../application/AnalysisSettings.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  DEFAULT_NTFS_MFT_MAX_FILE_BYTES,
  MAXIMUM_NTFS_MFT_MAX_FILE_BYTES,
  MINIMUM_NTFS_MFT_MAX_FILE_BYTES,
  NTFS_MFT_MAX_FILE_SETTING,
  NTFS_MFT_MAX_FILE_SETTING_ID,
} from "../domain/windows/ntfsMft.js";
import { parseEnvironment } from "./environment.js";
import {
  NTFS_MFT_FILE_ADMISSION_CONSTRAINT,
  parseNtfsMftFileAdmission,
  runtimeNtfsMftFileAdmission,
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

  it("lists the ceiling and rejects a runtime value outside the range", () => {
    const settings = new AnalysisSettings({});
    expect(
      settings.inspect({ settings: [NTFS_MFT_MAX_FILE_SETTING_ID] }).settings,
    ).toEqual([
      expect.objectContaining({
        setting: NTFS_MFT_MAX_FILE_SETTING_ID,
        value: DEFAULT_NTFS_MFT_MAX_FILE_BYTES,
        source: "default",
        unit: "bytes",
        minimum: MINIMUM_NTFS_MFT_MAX_FILE_BYTES,
        maximum: MAXIMUM_NTFS_MFT_MAX_FILE_BYTES,
        environment: NTFS_MFT_MAX_FILE_SETTING,
        applies_at: "next_operation",
        agent_editable: true,
      }),
    ]);
    const admission = runtimeNtfsMftFileAdmission({}, settings.read);
    const rejected = settings.update({
      changes: [
        {
          setting: NTFS_MFT_MAX_FILE_SETTING_ID,
          action: "set",
          value: MINIMUM_NTFS_MFT_MAX_FILE_BYTES - 1,
        },
      ],
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(projectAnalysisError(rejected.error)).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "update_analysis_settings",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["changes", 0, "value"],
            reason: "out_of_range",
            minimum: MINIMUM_NTFS_MFT_MAX_FILE_BYTES,
          }),
        ]),
      },
    });
    expect(admission.maximumBytes).toBe(DEFAULT_NTFS_MFT_MAX_FILE_BYTES);
    expect(admission.source).toBe("default");
    const above = settings.update({
      changes: [
        {
          setting: NTFS_MFT_MAX_FILE_SETTING_ID,
          action: "set",
          value: MAXIMUM_NTFS_MFT_MAX_FILE_BYTES + 1,
        },
      ],
    });
    expect(above.ok).toBe(false);
    if (above.ok) return;
    expect(projectAnalysisError(above.error).details?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["changes", 0, "value"],
          reason: "out_of_range",
          maximum: MAXIMUM_NTFS_MFT_MAX_FILE_BYTES,
        }),
      ]),
    );
  });

  it("keeps an accepted call on the snapshot from when it started", async () => {
    const settings = new AnalysisSettings({});
    const admission = runtimeNtfsMftFileAdmission({}, settings.read);
    let seen = 0;
    const pending = settings.run(async () => {
      await Promise.resolve();
      seen = admission.maximumBytes;
      expect(admission.source).toBe("default");
    });
    const updated = settings.update({
      changes: [
        {
          setting: NTFS_MFT_MAX_FILE_SETTING_ID,
          action: "set",
          value: MINIMUM_NTFS_MFT_MAX_FILE_BYTES,
        },
      ],
    });
    expect(updated.ok).toBe(true);
    await pending;
    expect(seen).toBe(DEFAULT_NTFS_MFT_MAX_FILE_BYTES);
    expect(admission.maximumBytes).toBe(MINIMUM_NTFS_MFT_MAX_FILE_BYTES);
    expect(admission.source).toBe("runtime");
  });
});
