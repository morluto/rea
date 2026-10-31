import { expect, it } from "vitest";

import { parseWabtWat } from "../../../src/wasm/WabtWat.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { wasmInterfaceComparisonSchema } from "../../../src/contracts/wasm/wasmComparisonContracts.js";
import { compareWasmInterfaces } from "../../../src/application/wasm/WasmInterfaceComparisonService.js";
import { wasmArtifactFixture } from "../../fixtures/wasm/artifact.js";

it("does not call colliding rendered debug identifiers unchanged after a second function signature changes", async () => {
  const input = (parameter: string) => {
    const report = wasmArtifactFixture();
    report.interface = parseWabtWat(
      `(module (func $same (param i32)) (func $same (param ${parameter})) (export "first" (func $same)) (export "second" (func $same)))`,
    ).interface;
    return createEvidence(
      {
        path: report.artifact.path,
        sha256: report.artifact.sha256,
        format: "file",
      },
      { id: "fixture", name: "typed fixture", version: "1" },
      {
        operation: "inspect_wasm_artifact",
        parameters: { path: report.artifact.path },
        result: report,
        confidence: "observed",
      },
    );
  };
  const result = await compareWasmInterfaces({
    left: input("i32"),
    right: input("i64"),
    scope: "both",
  });
  if (!result.ok) throw result.error;
  const report = wasmInterfaceComparisonSchema.parse(
    result.value.evidence.normalized_result,
  );
  expect(report.changes.map(({ state }) => state)).toEqual([
    "unknown",
    "unknown",
  ]);
  expect(report.summary.unchanged).toBe(0);
});
