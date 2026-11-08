import { analysisSettingLimit } from "../../../src/domain/analysisSettingDefinitions.js";
import { expect, it } from "vitest";

import { AnalysisResourceConstraintError } from "../../../src/domain/analysisErrorCore.js";
import type { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { redactExplicitFailure } from "../../../src/domain/explicitSensitiveFailure.js";
import { fixedAllowanceOptions } from "../../../src/domain/fixedAllowanceRemediation.js";
import { analysisClientFailureForOperation } from "../../../src/providers/AnalysisClientFailure.js";

const refusal = () =>
  new AnalysisResourceConstraintError(
    "provider_stage",
    "memory",
    "decoded representation exceeds the fixture allowance",
    { maximum_decoded_bytes: 64 },
    fixedAllowanceOptions(
      "The explicit-secret fixture decode allowance",
      "parser",
    ),
  );

it.each([
  {
    boundary: "operation attribution",
    copy: (error: AnalysisError) =>
      analysisClientFailureForOperation(error, "fixture", "inspect_fixture"),
    allowance: "The explicit-secret fixture decode allowance",
  },
  {
    boundary: "explicit redaction",
    copy: (error: AnalysisError) =>
      redactExplicitFailure(error, ["explicit-secret"]),
    allowance: "The [REDACTED] fixture decode allowance",
  },
])(
  "keeps a fixed allowance's derived recovery through $boundary",
  ({ copy, allowance }) => {
    const copied = copy(refusal());
    expect(copied).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(copied).toMatchObject({
      fixedAllowance: { name: allowance, kind: "parser" },
      remediationAction: undefined,
      retryable: false,
    });
    const projected = projectAnalysisError(copied);
    expect(projected).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      remediation: { action: expect.stringContaining(allowance) },
      details: { reported_limits: { maximum_decoded_bytes: 64 } },
    });
    expect(projected.remediation.action).toMatch(/host memory do not raise/iu);
    expect(projected.remediation.action).toMatch(/unchanged request.*fails/iu);
  },
);

it.each(["operation attribution", "explicit redaction"])(
  "preserves structured adjustable limits through %s",
  (boundary) => {
    const original = refusal().bindLimit(
      analysisSettingLimit("regex.matching_deadline_ms", 123, "runtime"),
    );
    const copied =
      boundary === "operation attribution"
        ? analysisClientFailureForOperation(
            original,
            "hopper",
            "search_strings",
          )
        : redactExplicitFailure(original, ["explicit-secret"]);
    expect(copied).not.toBe(original);
    expect(copied.limit).toEqual(original.limit);
    expect(projectAnalysisError(copied)).toMatchObject({
      details: { limit: original.limit },
    });
    expect(original.message).toContain("fixture allowance");
  },
);
