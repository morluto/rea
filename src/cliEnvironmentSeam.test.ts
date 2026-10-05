import { describe, expect, it } from "vitest";

import { createCli } from "./cli.js";
import { createSystemDoctorHost } from "./doctorRuntime.js";
import { captureProcessScenarioFile } from "./application/ProcessCli.js";
import { runCapabilityStatus } from "./application/DirectAnalysisStatus.js";

describe("the CLI takes its environment as an input", () => {
  it("builds from an explicitly supplied environment", () => {
    expect(createCli({ REA_LOG_LEVEL: "debug" })).toBeDefined();
    expect(createCli({})).toBeDefined();
  });

  it("still builds with no environment supplied", () => {
    // The default keeps production behaviour identical.
    expect(createCli()).toBeDefined();
    expect(createSystemDoctorHost()).toBeDefined();
  });

  it("builds a doctor host from an explicit environment", () => {
    expect(createSystemDoctorHost({})).toBeDefined();
  });

  it("drives a process scenario failure from the supplied environment", async () => {
    await expect(
      captureProcessScenarioFile("/nonexistent/scenario.json", {}),
    ).resolves.toBeDefined();
  });

  it("reports session status from a supplied environment", async () => {
    // An invalid configuration must surface through the caller's supplied
    // environment rather than whatever the process happens to carry.
    const result = await runCapabilityStatus(undefined, {
      REA_LOG_LEVEL: "not-a-level",
    });
    expect(result).toMatchObject({ error: expect.anything() });
  });
});
