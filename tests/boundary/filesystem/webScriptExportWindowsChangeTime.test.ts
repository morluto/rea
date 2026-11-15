import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, onTestFinished, vi } from "vitest";

import { exportWebScripts } from "../../../src/application/WebScriptExportService.js";
import { ArtifactResourceScope } from "../../../src/resources/ArtifactResourceScope.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { scriptCaptureEvidenceFixture } from "../../fixtures/webScriptCapture.js";

// The capture read settles its ChangeTime baseline by the running host's
// rules; select Windows, whose settle budget comes from the environment.
vi.mock("../../../src/platform/HostPlatform.js", () => ({
  HOST_PLATFORM: Object.freeze({ platform: "win32", architecture: "x64" }),
}));

it("retains invalid Windows ChangeTime configuration at the capture read boundary", async () => {
  const root = await createTestTempDirectory("rea-web-script-export-");
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  const input = {
    capture_path: join(root, "capture.json"),
    output_directory: join(root, "export"),
  };
  await writeFile(
    input.capture_path,
    JSON.stringify(scriptCaptureEvidenceFixture()),
  );
  vi.stubEnv("REA_WINDOWS_CHANGE_TIME_DRIFT_MS", "invalid");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const result = await exportWebScripts(input, resources);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected configuration refusal");
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "configuration_invalid",
    details: { settings: [{ setting: "REA_WINDOWS_CHANGE_TIME_DRIFT_MS" }] },
  });
});
