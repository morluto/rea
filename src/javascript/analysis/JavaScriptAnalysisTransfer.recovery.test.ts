import { expect, it } from "vitest";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { analyzeJavaScriptSemantics } from "../../domain/javascript/javascriptSemanticAnalysis.js";
import { projectJavaScriptModuleSemantics } from "../../domain/javascript/javascriptModuleSemanticIr.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import {
  javaScriptForwardedTransferRemediation,
  javaScriptTransferByteBudget,
  measureJavaScriptModuleTransfer,
} from "./JavaScriptAnalysisTransfer.js";

it("distinguishes the adjustable transfer file ceiling from the fixed record and maximum ceilings", () => {
  const ir = analyzeJavaScriptSemantics(
    "export function add(value) { return value + 1; }",
  );
  const module = projectJavaScriptModuleSemantics(ir);
  const measured = measureJavaScriptModuleTransfer(module);
  let caught: unknown;
  try {
    measureJavaScriptModuleTransfer(module, measured.bytes - 1);
  } catch (cause) {
    caught = cause;
  }
  if (!(caught instanceof AnalysisResourceConstraintError))
    throw new Error("Expected a transfer ceiling refusal");
  const projected = projectAnalysisError(caught);
  expect(projected).toMatchObject({
    code: "resource_constraint",
    details: {
      resource: "transport",
      reported_limits: {
        transfer_record_bytes: 8388608,
        transfer_file_bytes: measured.bytes - 1,
      },
    },
  });
  expect(projected.remediation.action).toContain(String(measured.bytes - 1));
  expect(projected.remediation.action).toMatch(
    /8388608.byte.*2147483648.byte.*no runtime override/iu,
  );
  expect(projected.remediation.action).toMatch(
    /source_paths.*effective file allowance/iu,
  );
  expect(projected.remediation.action).toMatch(/max_heap_mb does not raise/iu);
  expect(projected.remediation.action).toMatch(/repeated unchanged/iu);
  const forwarded = javaScriptForwardedTransferRemediation(
    caught.reportedLimits,
  );
  expect(forwarded).toBe(projected.remediation.action);
  const recordOnly = javaScriptForwardedTransferRemediation({
    transfer_record_bytes: 8_388_608,
  });
  expect(recordOnly).toMatch(
    /effective transfer file ceiling follows.*parent.*heap/iu,
  );
  expect(recordOnly).toMatch(/record ceiling.*maximum.*no runtime override/iu);
  expect(javaScriptForwardedTransferRemediation(null)).toBeUndefined();
});

it("keeps the 2 GiB transfer file maximum fixed", () => {
  const maximum = 2_147_483_648;
  expect(javaScriptTransferByteBudget(maximum * 8)).toBe(maximum);
  expect(javaScriptTransferByteBudget(maximum * 16)).toBe(maximum);
  const recovery = javaScriptForwardedTransferRemediation({
    transfer_file_bytes: maximum,
  });
  expect(recovery).toMatch(/2147483648.byte.*maximum.*no runtime override/iu);
  expect(recovery).toMatch(/fewer source_paths does not raise.*maximum/iu);
});
