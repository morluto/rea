import { expect, it } from "vitest";

import { ANALYSIS_SETTINGS } from "../domain/analysisSettingDefinitions.js";
import { parseConfig } from "./parseConfig.js";
import { parseEnvironment } from "./environment.js";

it("admits invalid runtime-owned launch seeds at startup", () => {
  for (const definition of Object.values(ANALYSIS_SETTINGS)) {
    if (definition.updateMode !== "runtime" || !("environment" in definition))
      continue;
    const environment = { [definition.environment]: "not-a-number" };
    expect(parseEnvironment(environment).ok, definition.environment).toBe(true);
    expect(parseConfig(environment).ok, definition.environment).toBe(true);
  }
});
