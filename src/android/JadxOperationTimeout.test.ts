import { expect, it } from "vitest";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { captureJadxFailure } from "./JadxFailure.js";

it("names REA_JADX_OPERATION_TIMEOUT_MS when the operation deadline elapses", () => {
  const timeout = AbortSignal.abort(new Error("deadline"));
  const present = captureJadxFailure({
    cause: timeout.reason,
    request: {
      operation: "inspect_android_package",
      input: { path: "/targets/app.apk" },
    },
    timeout,
    timeoutMs: 1500,
    signal: undefined,
    session: undefined,
  });
  const projected = projectAnalysisError(present());
  expect(projected.message).toContain("1500 ms");
  expect(projected.remediation.action).toContain(
    "REA_JADX_OPERATION_TIMEOUT_MS",
  );
  expect(projected.remediation.action).toContain("update_analysis_settings");
  expect(projected.remediation.action).toContain("jadx.operation_timeout_ms");
  expect(projected.remediation.action).toContain(
    "next operation without restarting REA",
  );
  expect(projected.details).toMatchObject({
    limit: {
      setting: "jadx.operation_timeout_ms",
      effective_value: 1500,
      unit: "ms",
      minimum: 1,
      maximum: 2_147_483_647,
      applies_at: "next_operation",
      agent_editable: true,
      scope: "rea-runtime",
      rea_restart_required: false,
    },
  });
  expect(projected).toMatchObject({
    code: "provider_timeout",
    details: { timeout_ms: 1500 },
  });
});
