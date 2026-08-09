import { describe, expect, it } from "vitest";

import { parseConfig } from "../../../src/config.js";

describe("capability flags", () => {
  it("rejects values outside the exact true/false boundary", () => {
    const result = parseConfig({
      REA_PROCESS_CAPTURE_ENABLED: "typo",
      REA_BROWSER_OBSERVE_ENABLED: "typo",
      REA_BROWSER_SCENARIO_ENABLED: "typo",
      REA_ELECTRON_OBSERVE_ENABLED: "typo",
      REA_ELECTRON_AUTOMATE_ENABLED: "typo",
      REA_V8_INSPECTOR_OBSERVE_ENABLED: "typo",
      REA_JAVASCRIPT_REPLAY_ENABLED: "typo",
      REA_MANAGED_RUNTIME_ENABLED: "typo",
    });

    expect(result.ok).toBe(false);
  });
});
