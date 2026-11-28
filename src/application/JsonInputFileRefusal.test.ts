import { constants } from "node:buffer";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as v8 from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readJsonInputFile } from "./JsonInputFile.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

vi.mock("node:v8", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:v8")>();
  return {
    ...actual,
    getHeapStatistics: vi.fn(actual.getHeapStatistics),
  };
});

describe("JsonInputFile resource constraint classification", () => {
  afterEach(async () => {
    const actual = await vi.importActual<typeof import("node:v8")>("node:v8");
    vi.mocked(v8.getHeapStatistics).mockImplementation(
      actual.getHeapStatistics,
    );
  });

  it("marks streaming container-assembly heap exhaustion as measuredExhaustion without fixed_ceiling refusal", async () => {
    const root = await createTestTempDirectory("rea-json-input-headroom-");
    const path = join(root, "doc.json");
    await writeFile(path, JSON.stringify({ ok: true }));
    const actual = await vi.importActual<typeof import("node:v8")>("node:v8");
    vi.mocked(v8.getHeapStatistics).mockReturnValue({
      ...actual.getHeapStatistics(),
      total_available_size: 0,
    });

    const result = await readJsonInputFile(path, "read_evidence_file");
    if (result.ok || !(result.error instanceof AnalysisResourceConstraintError))
      throw new Error("Expected low-headroom refusal");
    expect(result.error.recovery).toMatchObject({
      measuredExhaustion: true,
    });
    const projected = projectAnalysisError(result.error);
    expect(projected).toMatchObject({
      code: "resource_constraint",
      details: {
        operation: "read_evidence_file",
        resource: "memory",
        reported_limits: {
          input_path: path,
          available_heap_bytes: 0,
        },
      },
      remediation: {
        action: expect.stringContaining("re-analyze a smaller selection"),
      },
    });
    expect(projected.details).not.toHaveProperty("refusal");
  });

  it("marks long-scalar assembly heap exhaustion as measuredExhaustion", async () => {
    const root = await createTestTempDirectory("rea-json-scalar-headroom-");
    const path = join(root, "scalar.json");
    await writeFile(path, JSON.stringify("x".repeat(70_000)));
    const actual = await vi.importActual<typeof import("node:v8")>("node:v8");
    let calls = 0;
    vi.mocked(v8.getHeapStatistics).mockImplementation(() => {
      calls += 1;
      return {
        ...actual.getHeapStatistics(),
        // Force streaming mode on the first check and exhaust string-assembly headroom next.
        total_available_size:
          calls <= 2 ? 0 : actual.getHeapStatistics().total_available_size,
      };
    });

    const result = await readJsonInputFile(path, "trace_application_feature");
    if (result.ok || !(result.error instanceof AnalysisResourceConstraintError))
      throw new Error("Expected scalar-assembly headroom refusal");
    expect(result.error.recovery).toMatchObject({
      measuredExhaustion: true,
    });
    expect(result.error.reportedLimits).toMatchObject({
      input_path: path,
      string_code_units: expect.any(Number),
      string_assembly_headroom_bytes: expect.any(Number),
    });
    expect(projectAnalysisError(result.error).details).not.toHaveProperty(
      "refusal",
    );
  });

  it("projects a fixed_ceiling refusal when a streamed JSON scalar exceeds constants.MAX_STRING_LENGTH", async () => {
    const root = await createTestTempDirectory("rea-json-string-ceiling-");
    const path = join(root, "oversized.json");
    await writeFile(path, JSON.stringify({ key: "value" }));
    const actual = await vi.importActual<typeof import("node:v8")>("node:v8");
    let calls = 0;
    vi.mocked(v8.getHeapStatistics).mockImplementation(() => {
      calls += 1;
      return {
        ...actual.getHeapStatistics(),
        // Route through the streaming pipeline on nativeParseFits, then keep headroom available.
        total_available_size:
          calls === 1 ? 0 : actual.getHeapStatistics().total_available_size,
      };
    });
    const decodeSpy = vi
      .spyOn(TextDecoder.prototype, "decode")
      .mockImplementationOnce(() => {
        throw new RangeError("Invalid string length");
      });
    try {
      const result = await readJsonInputFile(path, "read_evidence_file");
      if (result.ok) throw new Error("Expected runtime string-length refusal");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "resource_constraint",
        retryable: false,
        details: {
          operation: "read_evidence_file",
          resource: "memory",
          reported_limits: {
            input_path: path,
            max_string_code_units: constants.MAX_STRING_LENGTH,
          },
          refusal: {
            kind: "fixed_ceiling",
            operation: "read_evidence_file",
            allowance: "The JavaScript runtime single-string length limit",
            allowance_kind: "parser",
            limit: constants.MAX_STRING_LENGTH,
            unit: "code_units",
          },
        },
      });
    } finally {
      decodeSpy.mockRestore();
    }
  });
});
