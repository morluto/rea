import { describe, expect, it } from "vitest";

import { moduleSourceBudgetJavaScriptSemanticIr } from "./javascriptSemanticIr.js";
import {
  exceedsSemanticModuleSourceBytesBudget,
  semanticResourceLimitReason,
  semanticResourceLimitUnknown,
  SEMANTIC_MODULE_SOURCE_BYTES_LIMIT,
} from "./javascriptSemanticResourceLimits.js";
import {
  semanticCoverageResourceLimits,
  semanticResourceLimitCoverage,
} from "./javascriptSemanticCoverage.js";

describe("module source-payload budget", () => {
  it("admits payloads at the budget and rejects payloads above it", () => {
    const within = `const pad = "${"a".repeat(SEMANTIC_MODULE_SOURCE_BYTES_LIMIT - 64)}";\n`;
    const above = `const pad = "${"a".repeat(SEMANTIC_MODULE_SOURCE_BYTES_LIMIT)}";\n`;
    expect(exceedsSemanticModuleSourceBytesBudget(within)).toBe(false);
    expect(exceedsSemanticModuleSourceBytesBudget(above)).toBe(true);
  });

  it("measures encoded bytes rather than UTF-16 code units", () => {
    // 1_048_577 two-byte code units encode to 2_097_154 UTF-8 bytes.
    const wide = "\u00e9".repeat(1_048_577);
    expect(wide.length).toBeLessThanOrEqual(SEMANTIC_MODULE_SOURCE_BYTES_LIMIT);
    expect(exceedsSemanticModuleSourceBytesBudget(wide)).toBe(true);
  });

  it("names the payload bound for callers", () => {
    expect(semanticResourceLimitReason("module-source-bytes")).toContain(
      "2097152",
    );
    expect(semanticResourceLimitCoverage(["module-source-bytes"])).toEqual([
      {
        name: "javascript_semantic_module_source_bytes",
        value: SEMANTIC_MODULE_SOURCE_BYTES_LIMIT,
        unit: "bytes",
      },
    ]);
    const unknown = semanticResourceLimitUnknown("module-source-bytes");
    expect(unknown).toMatchObject({
      status: "unknown",
      resourceLimit: "module-source-bytes",
    });
    expect(unknown.status === "unknown" && unknown.reason).toContain(
      "payload budget",
    );
  });
});

describe("module payload resource-limit IR", () => {
  it("degrades to an explicit failed coverage with the named bound", () => {
    const ir = moduleSourceBudgetJavaScriptSemanticIr();
    expect(ir.schema).toBe("JavaScriptSemanticIR");
    expect(ir.bindings).toEqual([]);
    expect(ir.references).toEqual([]);
    expect(ir.objectOperations).toEqual([]);
    expect(semanticCoverageResourceLimits(ir.coverage)).toEqual([
      "module-source-bytes",
    ]);
    expect(ir.coverage).toMatchObject({ status: "failed" });
    expect(ir.limitations).toContain(
      "The module source exceeds the 2097152-byte semantic payload budget; deep semantic analysis was skipped and no semantic absence claim is available for this module.",
    );
  });
});
