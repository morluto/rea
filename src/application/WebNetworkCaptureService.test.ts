import { expect, it } from "vitest";
import { WebNetworkCaptureService } from "./WebNetworkCaptureService.js";
import { historicalHar } from "../../tests/fixtures/historicalHar.js";
import { ok } from "../domain/result.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  webNetworkCaptureSchema,
  type WebNetworkCapture,
} from "../domain/webNetworkCapture.js";

it.each(["REDACTED", "[", "]", "/capture.har"])(
  "excludes sensitive path text even when a replacement marker would collide: %s",
  async (literal) => {
    const report = fixture();
    report.artifact.path = `/capture.har/${literal}`;
    const result = await new WebNetworkCaptureService({
      inspect: () => Promise.resolve(ok(report)),
    }).inspect({
      capture_path: report.artifact.path,
      format: "har",
      sensitive_values: [literal],
    });
    if (!result.ok) throw result.error;
    expect(result.value.subject?.local_path).not.toContain(literal);
    expect(result.value.parameters.capture_path).not.toContain(literal);
    expect(
      result.value.locations.every(
        (location) =>
          location.kind !== "artifact-path" || !location.path.includes(literal),
      ),
    ).toBe(true);
    expect(result.value.subject?.digest.sha256).toBe(report.artifact.sha256);
  },
);

it("keeps observed artifact identity when the entire sensitive path is excluded", async () => {
  const result = await new WebNetworkCaptureService({
    inspect: () => Promise.resolve(ok(fixture())),
  }).inspect({
    capture_path: "/capture.har",
    format: "har",
    sensitive_values: ["/", "[", "REDACTED"],
  });
  if (!result.ok) throw result.error;
  expect(result.value.subject).toMatchObject({
    local_path: "",
    digest: { sha256: "a".repeat(64) },
  });
  expect(result.value.locations).toEqual([]);
});

const fixture = (): WebNetworkCapture => ({
  decoder: { id: "test-historical-port", version: "1" },
  container: {
    reported: null,
    numeric_literals: [],
    redactions: [],
    records_pointer: "/log/entries",
  },
  total_records: 1,
  records: [
    {
      ordinal: 0,
      location: { kind: "json-pointer", pointer: "/log/entries/0" },
      reported: historicalHar().log.entries[0] ?? null,
      numeric_literals: [],
      binary_fields: [],
      redactions: [],
      limitations: [],
    },
  ],
  artifact: { path: "/capture.har", sha256: "a".repeat(64), bytes: 10 },
  format: "har",
  runtime_attribution: "unknown",
  limitations: ["historical fixture"],
});

it.each([
  ["producer"],
  ["artifact"],
  ["coordinates"],
  ["producer", "REDACTED", "…"],
  ["producer", "[", "]"],
])(
  "excludes declared literals from all authored limitations: %j",
  async (...literals) => {
    const report = fixture();
    report.artifact.path = "/artifact/capture.har";
    report.limitations = [
      "Historical producer artifact coordinates are retained.",
    ];
    const first = report.records[0];
    if (first === undefined) throw new Error("fixture missing record");
    first.limitations = ["This is producer-decoded artifact evidence."];
    const result = await new WebNetworkCaptureService({
      inspect: () => Promise.resolve(ok(report)),
    }).inspect({
      capture_path: report.artifact.path,
      format: "har",
      sensitive_values: literals,
    });
    if (!result.ok) throw result.error;
    const projected = webNetworkCaptureSchema.parse(
      result.value.normalized_result,
    );
    const texts = [
      result.value.limitations,
      projected.limitations,
      ...projected.records.map((record) => record.limitations),
    ].flat();
    for (const literal of literals)
      expect(texts.every((text) => !text.includes(literal))).toBe(true);
    expect(result.value.subject?.digest.sha256).toBe(report.artifact.sha256);
    expect(projected.decoder).toEqual(report.decoder);
    expect(projected.records[0]?.reported).toEqual(first.reported);
  },
);

it("keeps explicitly sensitive values out of Evidence parameters and preserves historical authority", async () => {
  const service = new WebNetworkCaptureService({
    inspect: () => Promise.resolve(ok(fixture())),
  });
  const result = await service.inspect({
    capture_path: "/capture.har",
    format: "har",
    sensitive_values: ["explicit-private-value"],
  });
  if (!result.ok) throw result.error;
  expect(result.value.parameters).toMatchObject({
    sensitive_value_count: 1,
    record_ordinals: [0],
  });
  expect(JSON.stringify(result.value)).not.toContain("explicit-private-value");
  expect(result.value.authority).toBe("historical-reference");
});

it.each(["har", "ha"])(
  "omits a format parameter containing a declared sensitive literal: %s",
  async (literal) => {
    const result = await new WebNetworkCaptureService({
      inspect: () => Promise.resolve(ok(fixture())),
    }).inspect({
      capture_path: "/capture.har",
      format: "har",
      sensitive_values: [literal],
    });
    if (!result.ok) throw result.error;
    expect(result.value.parameters).not.toHaveProperty("format");
    expect(JSON.stringify(result.value.parameters)).not.toContain(literal);
    expect(result.value.normalized_result).toMatchObject({ format: "har" });
  },
);

it.each([
  { record_ordinals: [0, 0] },
  { record_ordinals: [1] },
  { capture_path: "relative.har" },
])("rejects invalid caller selection %j", async (extra) => {
  const result = await new WebNetworkCaptureService({
    inspect: () => Promise.resolve(ok(fixture())),
  }).inspect({ capture_path: "/capture.har", format: "har", ...extra });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error._tag).toBe("AnalysisInputError");
});

it("rejects a port changing the artifact identity or producer ordinal sequence", async () => {
  const report = fixture();
  report.artifact.path = "/different.har";
  const result = await new WebNetworkCaptureService({
    inspect: () => Promise.resolve(ok(report)),
  }).inspect({ capture_path: "/capture.har", format: "har" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error._tag).toBe("AnalysisOutputError");
});

it("applies an explicit sensitive path literal after verifying the selected artifact", async () => {
  const result = await new WebNetworkCaptureService({
    inspect: () => Promise.resolve(ok(fixture())),
  }).inspect({
    capture_path: "/capture.har",
    format: "har",
    sensitive_values: ["capture.har"],
  });
  if (!result.ok) throw result.error;
  expect(JSON.stringify(result.value)).not.toContain("capture.har");
  expect(result.value.parameters.capture_path).toBe("");
});

it.each(["log", "entries"])(
  "excludes a sensitive producer coordinate without inventing a replacement: %s",
  async (literal) => {
    const result = await new WebNetworkCaptureService({
      inspect: () => Promise.resolve(ok(fixture())),
    }).inspect({
      capture_path: "/capture.har",
      format: "har",
      sensitive_values: [literal],
    });
    if (!result.ok) throw result.error;
    expect(result.value.normalized_result).toMatchObject({
      container: { records_pointer: null },
      records: [
        {
          ordinal: 0,
          location: { kind: "unknown", reason: "explicit-sensitive-value" },
        },
      ],
    });
    expect(JSON.stringify(result.value)).not.toContain(literal);
  },
);

it("excludes an escaped sensitive sidecar coordinate while preserving its reported field", async () => {
  const report = fixture();
  report.container.reported = { "field/name": 42 };
  report.container.numeric_literals = [
    { pointer: "/field~1name", producer_type: "json-number", literal: "42" },
  ];
  report.container.redactions = [
    { pointer: "/field~1name", reason: "explicit-sensitive-value" },
  ];
  const result = await new WebNetworkCaptureService({
    inspect: () => Promise.resolve(ok(report)),
  }).inspect({
    capture_path: "/capture.har",
    format: "har",
    sensitive_values: ["~1"],
  });
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toMatchObject({
    container: {
      reported: { "field/name": 42 },
      numeric_literals: [],
      redactions: [],
    },
  });
  expect(JSON.stringify(result.value)).not.toContain("~1");
});

it.each([
  { literal: "12345", input: { record_ordinals: [12345] } },
  { literal: "Each", input: { record_ordinals: [0, 0] } },
  { literal: "absolute", input: { capture_path: "relative.har" } },
  { literal: "secret", input: { mysecret: true } },
])(
  "excludes declared text from application-generated input errors: $literal",
  async ({ literal, input }) => {
    const result = await new WebNetworkCaptureService({
      inspect: () => Promise.resolve(ok(fixture())),
    }).inspect({
      capture_path: "/capture.har",
      format: "har",
      sensitive_values: [literal],
      ...input,
    });
    if (result.ok) throw new Error("Expected invalid selection");
    expect(result.error._tag).toBe("AnalysisInputError");
    expect(JSON.stringify(projectAnalysisError(result.error))).not.toContain(
      literal,
    );
  },
);
