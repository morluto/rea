import { describe, expect, it } from "vitest";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  WEB_BUNDLE_ENDPOINT_LITERAL_SETTING,
} from "../domain/webBundleEndpointLiteralBudget.js";
import { parseEnvironment } from "./environment.js";
import {
  parseWebBundleEndpointLiteralAdmission,
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
});
