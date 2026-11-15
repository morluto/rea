import { expect, it } from "vitest";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  DEFAULT_WASM_INTERFACE_REPRESENTATION_BYTES,
  MAX_WASM_INTERFACE_REPRESENTATION_BYTES,
} from "../domain/wasm/wasmInterface.js";
import { WasmInterfaceBudget } from "../domain/wasm/wasmInterfaceBudget.js";

it("refuses typed WASM interface growth without asking the caller to wait", () => {
  const budget = new WasmInterfaceBudget();
  expect(() =>
    budget.reserve(DEFAULT_WASM_INTERFACE_REPRESENTATION_BYTES + 1),
  ).toThrowError();
  try {
    budget.reserve(DEFAULT_WASM_INTERFACE_REPRESENTATION_BYTES + 1);
    throw new Error("Expected a representation refusal");
  } catch (error) {
    const projected = projectAnalysisError(
      error as Parameters<typeof projectAnalysisError>[0],
    );
    expect(projected).toMatchObject({
      retryable: false,
      details: {
        resource: "capacity",
        reported_limits: {
          maximum_bytes: DEFAULT_WASM_INTERFACE_REPRESENTATION_BYTES,
        },
      },
    });
    expect(projected.remediation.action).toContain("max_interface_bytes");
    expect(projected.remediation.action).not.toContain("fixed count");
    expect(projected.remediation.action).not.toMatch(
      /Wait for an active analysis/u,
    );
  }
});

it("does not suggest an impossible increase at the runtime representation maximum", () => {
  const budget = new WasmInterfaceBudget(
    MAX_WASM_INTERFACE_REPRESENTATION_BYTES,
  );
  try {
    budget.reserve(MAX_WASM_INTERFACE_REPRESENTATION_BYTES + 1);
    throw new Error("Expected serialization capacity refusal");
  } catch (error) {
    const projected = projectAnalysisError(
      error as Parameters<typeof projectAnalysisError>[0],
    );
    expect(projected).toMatchObject({
      details: { reported_limits: { source: "request" } },
    });
    expect(projected.remediation.action).toContain(
      "already at the runtime representation maximum",
    );
    expect(projected.remediation.action).not.toContain(
      "Raise max_interface_bytes",
    );
  }
});
