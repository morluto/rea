import { describe, expect, it } from "vitest";
import { otlpTraceSchema, type OtlpTraceArtifact } from "./otlpTrace.js";
import { parseOtlpTrace } from "./parseOtlpTrace.js";

const artifact: OtlpTraceArtifact = {
  path: "/artifacts/traces.json",
  sha256: "0".repeat(64),
  bytes: 1024,
};

const span = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  traceId: "a".repeat(32),
  spanId: "0".repeat(15) + "1",
  name: "root",
  kind: 2,
  startTimeUnixNano: "1000000000",
  endTimeUnixNano: "2000000000",
  ...overrides,
});

const envelope = (spans: unknown[]) => ({
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "checkout" } },
        ],
      },
      scopeSpans: [{ scope: { name: "lib", version: "1.2" }, spans }],
    },
  ],
});

const parse = (document: unknown) => {
  const parsed = parseOtlpTrace(document, artifact);
  if (!parsed.ok) throw new Error(parsed.problem);
  return otlpTraceSchema.parse(parsed.value);
};

describe("parseOtlpTrace", () => {
  it("retains span identity, service and scope across the parent link", () => {
    const report = parse(
      envelope([
        span({ spanId: "0".repeat(15) + "1" }),
        span({
          spanId: "0".repeat(15) + "2",
          parentSpanId: "0".repeat(15) + "1",
          name: "charge",
          kind: 3,
          startTimeUnixNano: "1100000000",
          endTimeUnixNano: "1500000000",
          status: { code: 2, message: "declined" },
          events: [{ name: "retry" }],
          links: [{ traceId: "b".repeat(32), spanId: "c".repeat(16) }],
        }),
      ]),
    );
    expect(report.summary).toMatchObject({
      spans: 2,
      roots: 1,
      orphans: 0,
      error_status: 1,
      with_parent: 1,
      distinct_traces: 1,
      distinct_services: 1,
    });
    expect(report.roots).toEqual(["0".repeat(15) + "1"]);
    const child = report.spans[1];
    expect(child).toMatchObject({
      span_id: "0".repeat(15) + "2",
      parent_span_id: "0".repeat(15) + "1",
      name: "charge",
      kind: "client",
      status_code: "error",
      status_message: "declined",
      service_name: "checkout",
      scope_name: "lib",
      scope_version: "1.2",
      duration_nano: "400000000",
      event_count: 1,
      link_count: 1,
    });
  });

  it("reports a parent the export does not contain as an orphan", () => {
    const report = parse(
      envelope([
        span({
          spanId: "0".repeat(15) + "2",
          parentSpanId: "f".repeat(16),
        }),
      ]),
    );
    expect(report.orphan_span_ids).toEqual(["f".repeat(16)]);
    expect(report.summary.orphans).toBe(1);
    expect(report.diagnostics.map((entry) => entry.code)).toContain(
      "missing-parent",
    );
    // The child stays parented to an unrecorded span; it is not promoted to a root.
    expect(report.summary.roots).toBe(0);
    expect(report.limitations.join(" ")).toContain("Recording completeness");
  });

  it("preserves a reversed interval without deriving a duration", () => {
    const report = parse(
      envelope([
        span({
          startTimeUnixNano: "2000000000",
          endTimeUnixNano: "1000000000",
        }),
      ]),
    );
    expect(report.spans[0]).toMatchObject({
      start_time_unix_nano: "2000000000",
      end_time_unix_nano: "1000000000",
      duration_nano: null,
    });
    expect(report.diagnostics.map((entry) => entry.code)).toContain(
      "invalid-time-interval",
    );
  });

  it("spells out duplicates instead of silently collapsing them", () => {
    const report = parse(
      envelope([span({ name: "first" }), span({ name: "second" })]),
    );
    expect(report.spans).toHaveLength(2);
    expect(report.summary.spans).toBe(2);
    expect(report.diagnostics.map((entry) => entry.code)).toContain(
      "duplicate-span-id",
    );
  });

  it("keeps resource attributes other than service.name and redacts them too", () => {
    const report = parse({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "gateway" } },
              { key: "deployment.environment", value: { stringValue: "prod" } },
              { key: "client_secret", value: { stringValue: "svc-secret" } },
            ],
          },
          scopeSpans: [{ spans: [span({})] }],
        },
      ],
    });
    const resource = report.spans[0]!.resource_attributes;
    expect(resource.map((entry) => entry.key)).toEqual([
      "deployment.environment",
      "client_secret",
    ]);
    expect(resource[0]).toMatchObject({ string_value: "prod" });
    expect(resource[1]).toMatchObject({ redacted: true, string_value: null });
    expect(report.summary.redacted_attributes).toBe(1);
    expect(report.spans[0]!.service_name).toBe("gateway");
  });

  it("reports a parent cycle without deriving order from it", () => {
    const report = parse(
      envelope([
        span({
          spanId: "0".repeat(15) + "1",
          parentSpanId: "0".repeat(15) + "2",
        }),
        span({
          spanId: "0".repeat(15) + "2",
          parentSpanId: "0".repeat(15) + "1",
        }),
      ]),
    );
    expect(report.diagnostics.map((entry) => entry.code)).toContain("cycle");
    expect(report.summary.roots).toBe(0);
  });

  it("skips a record without usable identifiers and says so", () => {
    const report = parse(envelope([span({ spanId: "not-a-span-id" })]));
    expect(report.summary.spans).toBe(0);
    expect(report.diagnostics.map((entry) => entry.code)).toContain(
      "invalid-record",
    );
  });

  it("rejects an envelope that is not an OTLP trace export", () => {
    const parsed = parseOtlpTrace({ resourceMetrics: [] }, artifact);
    expect(parsed).toMatchObject({ ok: false });
  });

  it("states that live collection and protobuf remain unsupported", () => {
    const report = parse(envelope([span({})]));
    expect(report.source_coverage).toMatchObject({
      encoding: "otlp-json",
      protobuf_encodings: "not-supported",
      live_collector: "not-contacted",
      recording_completeness: "unknown",
      clock_skew: "not-corrected",
    });
  });
});

describe("parseOtlpTrace attributes", () => {
  it("redacts credential-carrying attribute values and counts only element kinds", () => {
    const report = parse(
      envelope([
        span({
          attributes: [
            {
              key: "authorization",
              value: { stringValue: "Bearer secret" },
            },
            { key: "api_key", value: { stringValue: "also-secret" } },
            { key: "http.method", value: { stringValue: "POST" } },
            { key: "http.status_code", value: { intValue: "201" } },
            { key: "ok", value: { boolValue: true } },
            { key: "ratio", value: { doubleValue: 0.5 } },
            {
              key: "http.request.header.x-trace",
              value: { arrayValue: { values: [{ stringValue: "a" }] } },
            },
            { key: "blob", value: { bytesValue: "AAEC" } },
          ],
        }),
      ]),
    );
    const attributes = new Map(
      report.spans[0]!.attributes.map((entry) => [entry.key, entry]),
    );
    expect(attributes.get("authorization")).toMatchObject({
      redacted: true,
      string_value: null,
    });
    expect(attributes.get("api_key")).toMatchObject({ redacted: true });
    expect(report.summary.redacted_attributes).toBe(2);
    expect(attributes.get("http.method")).toMatchObject({
      value_kind: "string",
      string_value: "POST",
    });
    expect(attributes.get("http.status_code")).toMatchObject({
      value_kind: "int",
      int_value: "201",
    });
    expect(attributes.get("ok")).toMatchObject({
      value_kind: "bool",
      bool_value: true,
    });
    expect(attributes.get("ratio")).toMatchObject({
      value_kind: "double",
      double_value: 0.5,
    });
    expect(attributes.get("http.request.header.x-trace")).toMatchObject({
      value_kind: "array",
      element_count: 1,
    });
    expect(attributes.get("blob")).toMatchObject({
      value_kind: "bytes",
      bytes_length: 3,
    });
  });

  it("keeps base64 identifiers usable by normalizing them to hex", () => {
    const traceBytes = Buffer.alloc(16, 0xab);
    const spanBytes = Buffer.alloc(8, 0xcd);
    const report = parse(
      envelope([
        span({
          traceId: traceBytes.toString("base64"),
          spanId: spanBytes.toString("base64"),
        }),
      ]),
    );
    expect(report.spans[0]).toMatchObject({
      trace_id: traceBytes.toString("hex"),
      span_id: spanBytes.toString("hex"),
    });
  });
});
