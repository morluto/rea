import { expect, it } from "vitest";
import { analysisSettingLimit } from "./analysisSettingDefinitions.js";
import {
  AnalysisResourceConstraintError,
  reattributedResourceConstraint,
} from "./analysisErrorCore.js";
import { projectAnalysisError } from "./analysisErrorProjection.js";

it("keeps the structured limit when a resource refusal is reattributed", () => {
  const limit = analysisSettingLimit(
    "bridge.max_request_bytes",
    8192,
    "runtime",
  );
  const original = new AnalysisResourceConstraintError(
    "cutter_command",
    "transport",
    "Cutter status exceeded the request ceiling.",
    { max_request_bytes: 8192 },
    {
      remediationAction: "Raise bridge.max_request_bytes.",
      retryable: false,
      limit,
    },
  );
  const discovery = reattributedResourceConstraint(
    "list_cutter_sessions",
    original,
  );
  expect(discovery.operation).toBe("list_cutter_sessions");
  expect(discovery.limit).toEqual(original.limit);
  expect(discovery.recovery).toEqual(original.recovery);
  expect(discovery.reportedLimits).toEqual(original.reportedLimits);
  const projected = projectAnalysisError(discovery);
  expect(projected).toMatchObject({
    code: "resource_constraint",
    details: {
      limit: {
        setting: "bridge.max_request_bytes",
        effective_value: 8192,
        source: "runtime",
      },
    },
  });
});
