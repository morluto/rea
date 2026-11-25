import { describe, expect, it } from "vitest";
import {
  estimateJsonStorage,
  estimateJsonArrayScalarEntry,
  requireAuthenticationHeadroom,
} from "./JsonAuthenticationHeadroom.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";

it("stops a bounded representation scan before visiting an over-budget tail", () => {
  const value = {
    first: "x".repeat(1_024),
    get tail() {
      throw new Error("The rejected representation must not read its tail");
    },
  };
  const measured = estimateJsonStorage(value, {
    maximumValueBytes: 512,
    includeSerialized: false,
  });
  expect(measured.valueBytes).toBeGreaterThan(512);
});
it("checks escaped complete JSON against serialization capacity independently of heap", () => {
  const value = {
    normalized_result: { wat: '\0"\\😀'.repeat(30), imports: ["\0"] },
    raw_result: null,
  };
  const encodedLength = JSON.stringify(value).length;
  const options = {
    operation: "inspect_wasm_artifact",
    path: "/module.wasm",
    description: "Complete WASM Evidence cannot be assembled",
    availableBytes: Number.MAX_SAFE_INTEGER,
  };
  const rejected = requireAuthenticationHeadroom(value, {
    ...options,
    serializedCodeUnitLimit: encodedLength - 1,
  });
  expect(rejected).toMatchObject({
    ok: false,
    error: {
      retryable: false,
      reportedLimits: {
        serialized_json_code_units: encodedLength,
        maximum_serialized_json_code_units: encodedLength - 1,
      },
    },
  });
  expect(
    requireAuthenticationHeadroom(value, {
      ...options,
      serializedCodeUnitLimit: encodedLength,
    }),
  ).toEqual({ ok: true, value: undefined });
});

describe("JSON authentication headroom", () => {
  it("measures source IDs without first constructing their array", () => {
    const values = ["ev_123", null, 'escaped"\n😀'];
    const empty = estimateJsonStorage({ evidence_links: [] });
    const incremental = values.reduce((total, value, index) => {
      const entry = estimateJsonArrayScalarEntry(value, index > 0);
      return {
        valueBytes: total.valueBytes + entry.valueBytes,
        serializedUtf16Bytes:
          total.serializedUtf16Bytes + entry.serializedUtf16Bytes,
      };
    }, empty);
    expect(incremental.valueBytes).toBe(
      estimateJsonStorage({ evidence_links: values }).valueBytes,
    );
    expect(incremental.serializedUtf16Bytes).toBe(
      Buffer.byteLength(JSON.stringify({ evidence_links: values }), "utf16le"),
    );
  });

  it("accounts for parsed and escaped storage reserved by a caller", () => {
    const value = { result: "small" };
    const request = {
      operation: "address_name",
      path: "recovery",
      description: "Cannot authenticate",
      availableBytes: 18_000,
    };
    const additional = { valueBytes: 8192, serializedUtf16Bytes: 2048 };
    expect(requireAuthenticationHeadroom(value, request)).toEqual({
      ok: true,
      value: undefined,
    });
    const actual = requireAuthenticationHeadroom(value, {
      ...request,
      additional,
    });
    expect(actual).toMatchObject({
      ok: false,
      error: {
        resource: "memory",
        reportedLimits: {
          serialized_json_utf16_bytes:
            Buffer.byteLength(JSON.stringify(value), "utf16le") + 2048,
          available_heap_bytes: 18_000,
        },
      },
    });
    expect(
      requireAuthenticationHeadroom(value, {
        ...request,
        additional,
        availableBytes: 24_000,
      }),
    ).toEqual({ ok: true, value: undefined });
  });

  it("does not queue every row while deciding whether a wide report can fit", () => {
    let pending = 0;
    const rows: { admission_probe: boolean }[] = [];
    for (let index = 0; index < 512; index++) {
      const row = {
        get admission_probe() {
          pending--;
          return true;
        },
      };
      // Observe reading a row separately from examining its scalar. A width
      // queue reads every row first; an iterator finishes each row before advancing.
      Object.defineProperty(rows, index, {
        enumerable: true,
        get: () => {
          if (++pending > 32)
            throw new Error(
              "Admission queued report rows before refusing their allocation",
            );
          return row;
        },
      });
    }
    const value = { rows };
    const result = requireAuthenticationHeadroom(value, {
      operation: "inspect_managed_members",
      path: "/tmp/parent.json",
      description: "Cannot authenticate",
      availableBytes: 0,
    });
    expect(pending).toBe(0);
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisResourceConstraintError",
        reportedLimits: {
          serialized_json_utf16_bytes: JSON.stringify(value).length * 2,
        },
      },
    });
  });
});

it.each([
  ["control characters", { text: "\u0000\u0001\b\t\n\f\r".repeat(2000) }],
  [
    "escaped keys",
    { ['\u0000\\"'.repeat(2000)]: [true, false, null, -0, 1e30] },
  ],
  ["surrogate boundaries", { text: "😀\ud800x\udfff".repeat(2000) }],
])("reserves actual escaped JSON storage for %s", (_label, value) => {
  const allowance = 64 * 1024;
  const result = requireAuthenticationHeadroom(value, {
    operation: "inspect_analysis_view",
    path: "/tmp/bundle.json",
    description: "Cannot authenticate bundle",
    availableBytes: allowance,
  });
  if (result.ok) throw new Error("Expected authentication refusal");
  expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  expect(result.error.reportedLimits?.projected_value_bytes).toBeLessThan(
    allowance / 2,
  );
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisResourceConstraintError",
      reportedLimits: {
        available_heap_bytes: allowance,
        serialized_json_utf16_bytes: JSON.stringify(value).length * 2,
      },
    },
  });
});
