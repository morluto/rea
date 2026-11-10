import { describe, expect, it } from "vitest";

import { AnalysisSettings } from "../application/AnalysisSettings.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  WEB_BUNDLE_ENDPOINT_LITERAL_SETTING,
  WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID,
} from "../domain/webBundleEndpointLiteralBudget.js";
import { parseEnvironment } from "./environment.js";
import {
  parseWebBundleEndpointLiteralAdmission,
  runtimeWebBundleEndpointLiteralAdmission,
  WEB_BUNDLE_ENDPOINT_LITERAL_CONSTRAINT,
} from "./webBundleEndpointLiteralCandidates.js";

const rejectedSetting = {
  setting: WEB_BUNDLE_ENDPOINT_LITERAL_SETTING,
  constraint: WEB_BUNDLE_ENDPOINT_LITERAL_CONSTRAINT,
};

describe("web bundle literal endpoint candidate admission", () => {
  it("keeps the default when the setting is unset", () => {
    expect(parseWebBundleEndpointLiteralAdmission(undefined)).toEqual({
      ok: true,
      value: {
        maximumCount: DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
        source: "default",
      },
    });
    expect(DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES).toBe(1024);
  });

  it("accepts a decimal ceiling at the floor, the default, and the maximum", () => {
    for (const maximumCount of [
      MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
      DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
      MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
    ]) {
      expect(
        parseWebBundleEndpointLiteralAdmission(String(maximumCount)),
      ).toEqual({
        ok: true,
        value: { maximumCount, source: "setting" },
      });
    }
  });

  it.each([
    "0",
    String(MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES + 1),
    "0x10",
    "1e2",
    `0${String(DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES)}`,
  ])("refuses %j as a launch value", (value) => {
    const parsed = parseWebBundleEndpointLiteralAdmission(value);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.settings).toEqual([rejectedSetting]);
    expect(projectAnalysisError(parsed.error)).toMatchObject({
      code: "configuration_invalid",
      details: { settings: [rejectedSetting] },
    });
    const startup = parseEnvironment({
      [WEB_BUNDLE_ENDPOINT_LITERAL_SETTING]: value,
    });
    expect(startup.ok).toBe(false);
    if (startup.ok) return;
    expect(startup.error.settings).toEqual([rejectedSetting]);
  });

  it("lists the ceiling and rejects a runtime value outside the range", () => {
    const settings = new AnalysisSettings({});
    expect(
      settings.inspect({ settings: [WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID] })
        .settings,
    ).toEqual([
      expect.objectContaining({
        setting: WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID,
        value: DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
        source: "default",
        unit: "count",
        minimum: MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
        maximum: MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
        environment: WEB_BUNDLE_ENDPOINT_LITERAL_SETTING,
        applies_at: "next_operation",
        agent_editable: true,
      }),
    ]);
    const admission = runtimeWebBundleEndpointLiteralAdmission(
      {},
      settings.read,
    );
    const rejected = settings.update({
      changes: [
        {
          setting: WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID,
          action: "set",
          value: 0,
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
            minimum: MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
          }),
        ]),
      },
    });
    expect(admission.maximumCount).toBe(
      DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
    );
    expect(admission.source).toBe("default");
    const above = settings.update({
      changes: [
        {
          setting: WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID,
          action: "set",
          value: MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES + 1,
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
          maximum: MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
        }),
      ]),
    );
    expect(
      settings.update({
        changes: [
          {
            setting: WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID,
            action: "set",
            value: 2,
          },
        ],
      }).ok,
    ).toBe(true);
    expect(admission).toMatchObject({ maximumCount: 2, source: "runtime" });
  });
});
