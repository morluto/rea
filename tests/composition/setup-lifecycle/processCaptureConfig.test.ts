import { describe, expect, it } from "vitest";

import { parseConfig } from "../../../src/config.js";

describe("process capture configuration", () => {
  it("parses all authority required by enabled capture", () => {
    const result = parseConfig({
      REA_PROCESS_CAPTURE_ENABLED: "true",
      REA_PROCESS_EXECUTABLE_ROOTS_JSON: '["/opt/tools"]',
      REA_PROCESS_WORKING_ROOTS_JSON: '["/tmp/work"]',
      REA_PROCESS_ALLOWED_ENV_JSON: '["TOKEN"]',
      REA_PROCESS_ALLOW_EXTERNAL_NETWORK: "true",
    });
    if (!result.ok) throw result.error;
    expect(result.value.processExecutionPolicy).toEqual({
      status: "enabled",
      executableRoots: ["/opt/tools"],
      workingRoots: ["/tmp/work"],
      allowedEnvironment: ["TOKEN"],
      networkAccess: "external",
    });
  });

  it("requires both authority roots when capture is enabled", () => {
    expect(parseConfig({ REA_PROCESS_CAPTURE_ENABLED: "true" })).toMatchObject({
      ok: false,
    });
  });

  it("does not retain dormant process-capture authority", () => {
    const result = parseConfig({
      REA_PROCESS_CAPTURE_ENABLED: "false",
      REA_PROCESS_EXECUTABLE_ROOTS_JSON: '["/opt/tools"]',
      REA_PROCESS_WORKING_ROOTS_JSON: '["/tmp/work"]',
      REA_PROCESS_ALLOWED_ENV_JSON: '["TOKEN"]',
      REA_PROCESS_ALLOW_EXTERNAL_NETWORK: "true",
    });
    if (!result.ok) throw result.error;
    expect(result.value.processExecutionPolicy).toEqual({
      status: "disabled",
    });
  });
});
