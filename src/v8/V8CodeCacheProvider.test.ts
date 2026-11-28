import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  MAX_INSPECT_V8_CODE_CACHE_FILE_BYTES,
  MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES,
  MAX_INSPECT_V8_CODE_CACHE_STRINGS,
  V8_CODE_CACHE_BUDGETS,
  V8_CODE_CACHE_HEADER_BYTES,
  inspectV8CodeCacheInputSchema,
} from "../domain/v8/v8CodeCache.js";
import { v8CodeCacheFixture } from "./V8CodeCache.fixture.js";
import { V8CodeCacheProvider } from "./V8CodeCacheProvider.js";

it.each([
  {
    scenario: "both knobs have headroom",
    selection: { max_strings: 1 },
    retries: ["max_strings", "min_string_bytes"],
  },
  {
    scenario: "only count has headroom",
    selection: {
      max_strings: 1,
      min_string_bytes: MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES,
    },
    retries: ["max_strings"],
  },
  {
    scenario: "only run length has headroom",
    selection: { max_strings: MAX_INSPECT_V8_CODE_CACHE_STRINGS },
    retries: ["min_string_bytes"],
  },
  {
    scenario: "both knobs are at their ceilings",
    selection: {
      max_strings: MAX_INSPECT_V8_CODE_CACHE_STRINGS,
      min_string_bytes: MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES,
    },
    retries: [],
  },
])(
  "recommends the available retries when $scenario",
  async ({ selection, retries }) => {
    const root = await createTestTempDirectory("rea-v8-budget-");
    const path = join(root, "module.jsc");
    const input = inspectV8CodeCacheInputSchema.parse({ path, ...selection });
    // Every run meets the selected length threshold. One extra run triggers
    // the real parser guard, including when the count is at its ceiling.
    const run = Buffer.alloc(input.min_string_bytes + 1, 0x61);
    run[run.length - 1] = 0;
    const payloadBytes = run.length * (input.max_strings + 1);
    const bytes = Buffer.alloc(V8_CODE_CACHE_HEADER_BYTES + payloadBytes);
    v8CodeCacheFixture().copy(bytes, 0, 0, V8_CODE_CACHE_HEADER_BYTES);
    bytes.writeUInt32LE(payloadBytes, 20);
    bytes.fill(run, V8_CODE_CACHE_HEADER_BYTES);
    await writeFile(path, bytes);

    const provider = new V8CodeCacheProvider();
    const result = await provider
      .inspect(input)
      .finally(() => provider.close());
    if (result.ok) throw new Error("Expected observation budget exhaustion");
    const failure = result.error;
    if (!(failure instanceof AnalysisResourceConstraintError)) throw failure;
    expect(failure.reportedLimits).toEqual({
      boundary: "max_strings",
      maximum: input.max_strings,
    });
    expect(failure.limit).toEqual({
      control_kind: "parameter",
      parameter: "max_strings",
      effective_value: input.max_strings,
      unit: "count",
      minimum: V8_CODE_CACHE_BUDGETS.max_strings.minimum,
      maximum: MAX_INSPECT_V8_CODE_CACHE_STRINGS,
      default_value: V8_CODE_CACHE_BUDGETS.max_strings.default_value,
      applies_at: "next_call",
    });
    const projected = projectAnalysisError(failure);
    expect(projected).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      details: {
        limit: failure.limit,
        refusal: {
          kind: "adjustable_budget",
          operation: "inspect_v8_code_cache",
          control: "max_strings",
          effective_value: input.max_strings,
          unit: "count",
          range: {
            minimum: V8_CODE_CACHE_BUDGETS.max_strings.minimum,
            maximum: MAX_INSPECT_V8_CODE_CACHE_STRINGS,
          },
          default_value: V8_CODE_CACHE_BUDGETS.max_strings.default_value,
        },
      },
    });
    expect(projected.details?.limit).not.toHaveProperty("required_value");
    const advice = failure.remediationAction ?? "";
    expect(projected.remediation?.action).toBe(advice);
    const changes = [
      ...advice.matchAll(/\b(raise|lower) (max_strings|min_string_bytes)\b/giu),
    ].map(([instruction]) => instruction.toLowerCase());
    expect(changes.sort()).toEqual(
      retries.map((name) => `raise ${name}`).sort(),
    );
    if (retries.length === 0)
      expect(advice).toContain("select a smaller artifact");
  },
);

it("reports details.limit with required_value for max_file_bytes and admits the retry", async () => {
  const root = await createTestTempDirectory("rea-v8-file-size-");
  const path = join(root, "module.jsc");
  const bytes = v8CodeCacheFixture("function f(){ return 42; } f();");
  await writeFile(path, bytes);

  const provider = new V8CodeCacheProvider();
  try {
    const refused = await provider.inspect(
      inspectV8CodeCacheInputSchema.parse({ path, max_file_bytes: 36 }),
    );
    if (refused.ok) throw new Error("Expected file-size refusal");
    const failure = refused.error;
    if (!(failure instanceof AnalysisResourceConstraintError)) throw failure;
    expect(failure.remediationAction).toBeUndefined();
    expect(failure.limit).toEqual({
      control_kind: "parameter",
      parameter: "max_file_bytes",
      effective_value: 36,
      unit: "bytes",
      minimum: V8_CODE_CACHE_BUDGETS.max_file_bytes.minimum,
      maximum: MAX_INSPECT_V8_CODE_CACHE_FILE_BYTES,
      default_value: V8_CODE_CACHE_BUDGETS.max_file_bytes.default_value,
      applies_at: "next_call",
      required_value: bytes.length,
    });
    const projected = projectAnalysisError(failure);
    expect(projected).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      details: {
        limit: failure.limit,
        refusal: {
          kind: "adjustable_budget",
          operation: "inspect_v8_code_cache",
          control: "max_file_bytes",
          effective_value: 36,
          unit: "bytes",
          range: {
            minimum: V8_CODE_CACHE_BUDGETS.max_file_bytes.minimum,
            maximum: MAX_INSPECT_V8_CODE_CACHE_FILE_BYTES,
          },
          default_value: V8_CODE_CACHE_BUDGETS.max_file_bytes.default_value,
          required_value: bytes.length,
        },
      },
    });
    expect(projected.remediation?.action).toContain("max_file_bytes");
    expect(projected.remediation?.action).toContain(
      `at least ${String(bytes.length)} bytes`,
    );

    const admitted = await provider.inspect(
      inspectV8CodeCacheInputSchema.parse({
        path,
        max_file_bytes: bytes.length,
      }),
    );
    expect(admitted.ok).toBe(true);
  } finally {
    await provider.close();
  }
});

it.each([
  {
    scenario: "default budget with file above 64 MiB ceiling",
    selection: {},
    effectiveValue: V8_CODE_CACHE_BUDGETS.max_file_bytes.default_value,
    expectedMessage: "above the max_file_bytes maximum",
  },
  {
    scenario: "budget already at 64 MiB ceiling",
    selection: { max_file_bytes: MAX_INSPECT_V8_CODE_CACHE_FILE_BYTES },
    effectiveValue: MAX_INSPECT_V8_CODE_CACHE_FILE_BYTES,
    expectedMessage: "already at its maximum",
  },
])(
  "refuses a file larger than the max_file_bytes ceiling ($scenario)",
  async ({ selection, effectiveValue, expectedMessage }) => {
    const root = await createTestTempDirectory("rea-v8-file-ceiling-");
    const path = join(root, "oversized.jsc");
    const oversizeBytes = MAX_INSPECT_V8_CODE_CACHE_FILE_BYTES + 1;
    await writeFile(path, Buffer.alloc(0));
    await truncate(path, oversizeBytes);

    const provider = new V8CodeCacheProvider();
    try {
      const refused = await provider.inspect(
        inspectV8CodeCacheInputSchema.parse({ path, ...selection }),
      );
      if (refused.ok) throw new Error("Expected file-size ceiling refusal");
      const failure = refused.error;
      if (!(failure instanceof AnalysisResourceConstraintError)) throw failure;
      expect(failure.limit).toEqual({
        control_kind: "parameter",
        parameter: "max_file_bytes",
        effective_value: effectiveValue,
        unit: "bytes",
        minimum: V8_CODE_CACHE_BUDGETS.max_file_bytes.minimum,
        maximum: MAX_INSPECT_V8_CODE_CACHE_FILE_BYTES,
        default_value: V8_CODE_CACHE_BUDGETS.max_file_bytes.default_value,
        applies_at: "next_call",
        required_value: oversizeBytes,
      });
      const projected = projectAnalysisError(failure);
      expect(projected.remediation?.action).toContain(expectedMessage);
      expect(projected.remediation?.action).not.toContain(
        "Pass a larger max_file_bytes",
      );
    } finally {
      await provider.close();
    }
  },
);
