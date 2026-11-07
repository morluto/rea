import { expect, it } from "vitest";
import { providerConfigurationRefusal } from "./providerConfigurationRefusal.js";
import { projectAnalysisError } from "./analysisErrorProjection.js";

it("retains provider-owned configuration diagnostics and repair in public refusals", () => {
  const failure = Object.assign(new Error("version unreadable"), {
    remediation: "Inspect the selected launcher.",
    diagnostics: {
      selected_command: "/selected/apktool",
      command_source: "environment",
    },
  });
  expect(
    projectAnalysisError(
      providerConfigurationRefusal(
        "apktool",
        "inspect_apktool_client",
        failure,
      ),
    ),
  ).toMatchObject({
    code: "capability_unavailable",
    message: "version unreadable. Inspect the selected launcher.",
    remediation: {
      action: "version unreadable. Inspect the selected launcher.",
    },
    details: { diagnostics: failure.diagnostics },
  });
});
