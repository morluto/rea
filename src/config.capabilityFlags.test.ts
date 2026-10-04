import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

describe("capability flags", () => {
  it("rejects values outside the exact true/false boundary", () => {
    for (const key of [
      "REA_PROCESS_CAPTURE_ENABLED",
      "REA_BROWSER_OBSERVE_ENABLED",
      "REA_BROWSER_SCENARIO_ENABLED",
      "REA_ELECTRON_OBSERVE_ENABLED",
      "REA_ELECTRON_AUTOMATE_ENABLED",
      "REA_V8_INSPECTOR_OBSERVE_ENABLED",
      "REA_JAVASCRIPT_REPLAY_ENABLED",
      "REA_MANAGED_RUNTIME_ENABLED",
    ]) {
      const result = parseConfig({ [key]: "typo" });
      expect(result.ok, key).toBe(false);
    }
  });
});
