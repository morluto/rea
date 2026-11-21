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

  it("keeps resource attributes other than service.name with their source values", () => {
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
    const resource =
      report.resources[report.spans[0]!.resource_index]!.attributes;
    expect(resource.map((entry) => entry.key)).toEqual([
      "deployment.environment",
      "client_secret",
    ]);
    expect(resource[0]).toMatchObject({ string_value: "prod" });
    expect(resource[1]).toMatchObject({ string_value: "svc-secret" });
    expect(
      report.resources[report.spans[0]!.resource_index]!.service_name,
    ).toBe("gateway");
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

describe("parseOtlpTrace identifiers", () => {
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
    expect(report.resources[0]).toMatchObject({ service_name: "checkout" });
    expect(report.scopes[0]).toMatchObject({
      resource_index: 0,
      name: "lib",
      version: "1.2",
    });
    const child = report.spans[1];
    expect(child).toMatchObject({ resource_index: 0, scope_index: 0 });
    expect(child).toMatchObject({
      span_id: "0".repeat(15) + "2",
      parent_span_id: "0".repeat(15) + "1",
      name: "charge",
      kind: "client",
      status_code: "error",
      status_message: "declined",
      duration_nano: "400000000",
      event_count: 1,
      link_count: 1,
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

describe("parseOtlpTrace attributes", () => {
  it("preserves caller-supplied scalar attributes and counts nested kinds", () => {
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
      string_value: "Bearer secret",
    });
    expect(attributes.get("api_key")).toMatchObject({
      string_value: "also-secret",
    });
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
      bytes_base64: "AAEC",
    });
  });

  it("keeps equal-length byte values distinct", () => {
    const report = parse(
      envelope([
        span({
          attributes: [
            { key: "a", value: { bytesValue: "AAEC" } },
            { key: "b", value: { bytesValue: "AQID" } },
          ],
        }),
      ]),
    );
    const attributes = new Map(
      report.spans[0]!.attributes.map((a) => [a.key, a]),
    );
    expect(attributes.get("a")).toMatchObject({
      bytes_length: 3,
      bytes_base64: "AAEC",
    });
    expect(attributes.get("b")).toMatchObject({
      bytes_length: 3,
      bytes_base64: "AQID",
    });
  });
});

describe("parseOtlpTrace damaged service names", () => {
  it("keeps a service.name value the derived field cannot hold", () => {
    // `service_name` only carries a string, so a damaged export would
    // otherwise lose the recorded attribute with nothing left to say so.
    const document = envelope([span({})]) as {
      resourceSpans: { resource: { attributes: unknown[] } }[];
    };
    document.resourceSpans[0]!.resource.attributes = [
      { key: "service.name", value: { boolValue: false } },
    ];
    const report = parse(document);
    expect(report.resources[0]).toMatchObject({ service_name: null });
    expect(
      report.resources[0]!.attributes.map((attribute) => attribute.key),
    ).toEqual(["service.name"]);
  });

  it("does not repeat a string service.name in the resource attributes", () => {
    const report = parse(envelope([span({})]));
    expect(report.resources[0]).toMatchObject({ service_name: "checkout" });
    expect(report.resources[0]!.attributes).toEqual([]);
  });
});

describe("parseOtlpTrace defaults and signed integers", () => {
  it("reads an omitted status code as unset rather than an unknown code", () => {
    const report = parse(envelope([span({})]));
    expect(report.spans[0]?.status_code).toBe("unset");
  });

  it("keeps a negative intValue instead of dropping it", () => {
    const report = parse(
      envelope([
        span({
          attributes: [
            { key: "delta", value: { intValue: -5 } },
            { key: "offset", value: { intValue: "-9007199254740993" } },
          ],
        }),
      ]),
    );
    const attributes = new Map(
      report.spans[0]!.attributes.map((a) => [a.key, a]),
    );
    expect(attributes.get("delta")).toMatchObject({
      value_kind: "int",
      int_value: "-5",
    });
    expect(attributes.get("offset")).toMatchObject({
      value_kind: "int",
      int_value: "-9007199254740993",
    });
  });
});

describe("parseOtlpTrace 64-bit bounds", () => {
  it("keeps the extremes of the uint64 and int64 ranges", () => {
    const report = parse(
      envelope([
        span({
          startTimeUnixNano: "18446744073709551615",
          endTimeUnixNano: "18446744073709551615",
          attributes: [
            { key: "max", value: { intValue: "9223372036854775807" } },
            { key: "min", value: { intValue: "-9223372036854775808" } },
          ],
        }),
      ]),
    );
    const parsed = report.spans[0]!;
    expect(parsed.start_time_unix_nano).toBe("18446744073709551615");
    expect(parsed.duration_nano).toBe("0");
    const attributes = new Map(parsed.attributes.map((a) => [a.key, a]));
    expect(attributes.get("max")).toMatchObject({
      int_value: "9223372036854775807",
    });
    expect(attributes.get("min")).toMatchObject({
      int_value: "-9223372036854775808",
    });
  });

  it("rejects values outside the 64-bit range without converting them", () => {
    // A file that fits the size allowance can still carry an arbitrarily long
    // decimal. It must be refused on its length, not parsed into a BigInt.
    const tooLong = "9".repeat(5_000_000);
    const report = parse(
      envelope([
        span({
          startTimeUnixNano: "18446744073709551616",
          endTimeUnixNano: "1" + tooLong,
          attributes: [
            { key: "overflow", value: { intValue: "9223372036854775808" } },
            { key: "underflow", value: { intValue: "-9223372036854775809" } },
            { key: "huge", value: { intValue: "-" + tooLong } },
          ],
        }),
      ]),
    );
    const parsed = report.spans[0]!;
    expect(parsed.start_time_unix_nano).toBeNull();
    expect(parsed.end_time_unix_nano).toBeNull();
    expect(parsed.duration_nano).toBeNull();
    // A rejected value is still a recorded one: keep it so it cannot be read
    // as an omitted timestamp.
    expect(parsed.start_time_unix_nano_raw).toBe("18446744073709551616");
    const attributes = new Map(parsed.attributes.map((a) => [a.key, a]));
    expect(attributes.get("overflow")).toMatchObject({
      int_value: null,
      int_value_raw: "9223372036854775808",
    });
    expect(attributes.get("underflow")).toMatchObject({
      int_value: null,
      int_value_raw: "-9223372036854775809",
    });
    // The resource and scope facts are retained once, so each rejected value
    // is preserved rather than silently replaced by null at 256 characters.
    expect(parsed.end_time_unix_nano_raw).toBe("1" + tooLong);
    expect(attributes.get("huge")).toMatchObject({
      int_value: null,
      int_value_raw: "-" + tooLong,
    });
    expect(
      report.diagnostics.filter((d) => d.code === "invalid-record"),
    ).toHaveLength(1);
  });

  it("keeps raw fields empty when no value was recorded", () => {
    const report = parse(envelope([span({})]));
    const parsed = report.spans[0]!;
    expect(parsed.start_time_unix_nano_raw).toBeNull();
    expect(parsed.end_time_unix_nano_raw).toBeNull();
    expect(parsed.attributes.map((a) => a.int_value_raw)).toEqual([]);
  });

  it("retains non-finite double spellings instead of dropping them", () => {
    const report = parse(
      envelope([
        span({
          attributes: [
            { key: "nan", value: { doubleValue: "NaN" } },
            { key: "pos", value: { doubleValue: "Infinity" } },
            { key: "neg", value: { doubleValue: "-Infinity" } },
          ],
        }),
      ]),
    );
    const attributes = new Map(
      report.spans[0]!.attributes.map((a) => [a.key, a]),
    );
    for (const [key, raw] of [
      ["nan", "NaN"],
      ["pos", "Infinity"],
      ["neg", "-Infinity"],
    ] as const) {
      expect(attributes.get(key)).toMatchObject({
        value_kind: "double",
        double_value: null,
        double_value_raw: raw,
      });
    }
  });

  it("distinguishes an explicitly invalid null timestamp from an omitted one", () => {
    const invalid = parse(envelope([span({ startTimeUnixNano: null })]));
    expect(invalid.diagnostics.map((entry) => entry.code)).toContain(
      "invalid-record",
    );
    const omitted = parse(envelope([span({ startTimeUnixNano: undefined })]));
    expect(omitted.diagnostics.map((entry) => entry.code)).not.toContain(
      "invalid-record",
    );
  });

  it("rejects a span whose required traceId or spanId is all zero", () => {
    for (const overrides of [
      { traceId: "0".repeat(32) },
      { spanId: "0".repeat(16) },
    ]) {
      const report = parse(envelope([span(overrides)]));
      expect(report.diagnostics.map((entry) => entry.code)).toContain(
        "invalid-record",
      );
      expect(report.summary.spans).toBe(0);
    }
    // A zero parentSpanId still means "no parent", not an invalid record.
    const child = parse(envelope([span({ parentSpanId: "0".repeat(16) })]));
    expect(child.diagnostics.map((entry) => entry.code)).not.toContain(
      "invalid-record",
    );
    expect(child.summary.spans).toBe(1);
  });
});

describe("parseOtlpTrace credential headers", () => {
  it("preserves recorded cookie and proxy-authorization attribute values", () => {
    const report = parse(
      envelope([
        span({
          attributes: [
            {
              key: "http.response.header.set-cookie",
              value: { stringValue: "session=abc" },
            },
            {
              key: "http.request.header.proxy-authorization",
              value: { stringValue: "Basic dXNlcg==" },
            },
          ],
        }),
      ]),
    );
    const attributes = new Map(
      report.spans[0]!.attributes.map((entry) => [entry.key, entry]),
    );
    expect(attributes.get("http.response.header.set-cookie")).toMatchObject({
      string_value: "session=abc",
    });
    expect(
      attributes.get("http.request.header.proxy-authorization"),
    ).toMatchObject({ string_value: "Basic dXNlcg==" });
  });
});

describe("parseOtlpTrace parent links", () => {
  it("does not resolve a parent recorded only in another trace", () => {
    const report = parse({
      resourceSpans: [
        {
          resource: {},
          scopeSpans: [
            {
              scope: { name: "lib" },
              spans: [
                span({ traceId: "b".repeat(32), spanId: "f".repeat(16) }),
              ],
            },
          ],
        },
        {
          resource: {},
          scopeSpans: [
            {
              scope: { name: "lib" },
              spans: [
                span({
                  traceId: "a".repeat(32),
                  spanId: "0".repeat(15) + "2",
                  parentSpanId: "f".repeat(16),
                }),
              ],
            },
          ],
        },
      ],
    });
    // The same span id exists, but under a different trace, so the link is
    // unrecorded here rather than satisfied by the other trace's span.
    expect(report.orphan_span_ids).toEqual(["f".repeat(16)]);
    expect(report.summary.orphans).toBe(1);
    // Only the other trace's span is a root; the child here is not promoted.
    expect(report.summary.roots).toBe(1);
  });

  it("reports an unreadable parent link instead of calling the span a root", () => {
    const report = parse(envelope([span({ parentSpanId: "broken" })]));
    expect(report.diagnostics.map((entry) => entry.code)).toContain(
      "invalid-record",
    );
    expect(report.spans[0]).toMatchObject({
      parent_span_id: null,
      parent_span_id_state: "invalid",
      parent_span_id_raw: "broken",
    });
    expect(report.roots).toEqual([]);
    expect(report.summary.roots).toBe(0);
  });

  it("distinguishes omitted, zero, valid and non-string parent identities", () => {
    const report = parse(
      envelope([
        span({ spanId: "1".repeat(16) }),
        span({ spanId: "2".repeat(16), parentSpanId: "0".repeat(16) }),
        span({ spanId: "3".repeat(16), parentSpanId: "1".repeat(16) }),
        span({ spanId: "4".repeat(16), parentSpanId: 42 }),
      ]),
    );
    expect(
      report.spans.map((entry) => [
        entry.parent_span_id_state,
        entry.parent_span_id_raw,
      ]),
    ).toEqual([
      ["absent", null],
      ["absent", "0".repeat(16)],
      ["valid", "1".repeat(16)],
      ["invalid", 42],
    ]);
    expect(report.roots).toEqual(["1".repeat(16), "2".repeat(16)]);
    expect(report.summary.with_parent).toBe(1);
  });

  it("identifies the source of malformed and unidentifiable span entries", () => {
    const report = parse(envelope([null, span({ spanId: "broken" })]));
    expect(
      report.diagnostics
        .filter((entry) => entry.code === "invalid-record")
        .map((entry) => entry.source_pointer)
        .sort(),
    ).toEqual([
      "/resourceSpans/0/scopeSpans/0/spans/0",
      "/resourceSpans/0/scopeSpans/0/spans/1",
    ]);
  });

  it("keeps a span-local diagnostic pointed at its own record", () => {
    const report = parse(
      envelope([
        span({
          spanId: "0".repeat(15) + "3",
          startTimeUnixNano: "2000",
          endTimeUnixNano: "1000",
        }),
      ]),
    );
    const reversed = report.diagnostics.find(
      (entry) => entry.code === "invalid-time-interval",
    );
    expect(reversed?.source_pointer).toBe(
      "/resourceSpans/0/scopeSpans/0/spans/0",
    );
  });
});

describe("parseOtlpTrace deep cycles", () => {
  it("detects a cycle longer than two spans without chasing the chain per span", () => {
    const id = (n: number) => "0".repeat(15) + String(n);
    const report = parse(
      envelope([
        span({ spanId: id(1), parentSpanId: id(2) }),
        span({ spanId: id(2), parentSpanId: id(3) }),
        span({ spanId: id(3), parentSpanId: id(1) }),
      ]),
    );
    expect(report.diagnostics.map((entry) => entry.code)).toContain("cycle");
    expect(report.summary.roots).toBe(0);
  });

  it("does not report a cycle for a long acyclic chain", () => {
    const id = (n: number) => n.toString(16).padStart(16, "0");
    const spans = Array.from({ length: 500 }, (_, n) =>
      span({ spanId: id(n + 1), parentSpanId: n === 0 ? undefined : id(n) }),
    );
    const report = parse(envelope(spans));
    expect(report.diagnostics.map((entry) => entry.code)).not.toContain(
      "cycle",
    );
    expect(report.summary.roots).toBe(1);
  });
});

describe("parseOtlpTrace resource attribute bound", () => {
  it("says when a resource exceeds the attribute allowance", () => {
    const report = parse({
      resourceSpans: [
        {
          resource: {
            attributes: Array.from({ length: 130 }, (_, n) => ({
              key: `plain-${n}`,
              value: { stringValue: "v" },
            })),
          },
          scopeSpans: [
            {
              scope: { name: "lib" },
              spans: [span({})],
            },
          ],
        },
      ],
    });
    expect(
      report.resources[report.spans[0]!.resource_index]!.attributes,
    ).toHaveLength(128);
    expect(report.limitations.join(" ")).toContain(
      "Some resources declare more than 128 attributes",
    );
  });
});

describe("parseOtlpTrace unreadable groups", () => {
  it("names a scope whose spans are not an array instead of returning empty", () => {
    const report = parse({
      resourceSpans: [
        {
          resource: {},
          scopeSpans: [{ scope: { name: "lib" }, spans: { oops: true } }],
        },
      ],
    });
    expect(report.summary.spans).toBe(0);
    const diagnostic = report.diagnostics.find(
      (entry) => entry.code === "invalid-record",
    );
    expect(diagnostic?.source_pointer).toBe(
      "/resourceSpans/0/scopeSpans/0/spans",
    );
    expect(diagnostic?.message).toContain("not an array");
  });
});

describe("parseOtlpTrace OTLP empty defaults", () => {
  it("reads omitted repeated fields and an empty parentSpanId as absent", () => {
    const report = parse({
      resourceSpans: [
        { resource: {}, scopeSpans: [{ scope: {} }] },
        {
          resource: {},
          scopeSpans: [
            {
              scope: { name: "lib" },
              spans: [span({ spanId: "0".repeat(15) + "1", parentSpanId: "" })],
            },
          ],
        },
      ],
    });
    expect(report.summary.spans).toBe(1);
    expect(report.summary.roots).toBe(1);
    expect(report.diagnostics).toEqual([]);
  });

  it("finds a cycle that spans two disagreeing duplicate records", () => {
    const trace = "a".repeat(32);
    const idA = "0".repeat(15) + "a";
    const idB = "0".repeat(15) + "b";
    const report = parse(
      envelope([
        span({ traceId: trace, spanId: idA }),
        span({ traceId: trace, spanId: idA, parentSpanId: idB }),
        span({ traceId: trace, spanId: idB, parentSpanId: idA }),
      ]),
    );
    expect(report.diagnostics.map((entry) => entry.code)).toContain("cycle");
  });
});

it("stores shared resource and scope facts once while preserving span associations", () => {
  const longValue = "shared-value-".repeat(200);
  const spans = Array.from({ length: 200 }, (_, index) =>
    span({ spanId: (index + 1).toString(16).padStart(16, "0") }),
  );
  const report = parse({
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "checkout" } },
            { key: "detail", value: { stringValue: longValue } },
          ],
        },
        scopeSpans: [{ scope: { name: longValue, version: "v1" }, spans }],
      },
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "billing" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "other", version: "v2" },
            spans: [span({ traceId: "b".repeat(32) })],
          },
        ],
      },
    ],
  });
  expect(report.resources).toHaveLength(2);
  expect(report.scopes).toHaveLength(2);
  expect(report.resources[0]?.attributes[0]?.string_value).toBe(longValue);
  expect(report.scopes[0]?.name).toBe(longValue);
  expect(report.spans[199]).toMatchObject({
    resource_index: 0,
    scope_index: 0,
  });
  expect(report.spans[200]).toMatchObject({
    resource_index: 1,
    scope_index: 1,
  });
  expect(JSON.stringify(report).length).toBeLessThan(200_000);
});

it("keeps separate scopes attached to the same resource", () => {
  const report = parse({
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "same" } }],
        },
        scopeSpans: [
          {
            scope: { name: "first" },
            spans: [span({ spanId: "1".repeat(16) })],
          },
          {
            scope: { name: "second" },
            spans: [span({ spanId: "2".repeat(16) })],
          },
        ],
      },
    ],
  });
  expect(report.resources).toHaveLength(1);
  expect(
    report.scopes.map(({ resource_index, name }) => [resource_index, name]),
  ).toEqual([
    [0, "first"],
    [0, "second"],
  ]);
  expect(
    report.spans.map(({ resource_index, scope_index }) => [
      resource_index,
      scope_index,
    ]),
  ).toEqual([
    [0, 0],
    [0, 1],
  ]);
});

describe("parseOtlpTrace diagnostic bound", () => {
  it("caps diagnostics from malformed groups and says it dropped the rest", () => {
    const report = parse({
      resourceSpans: Array.from({ length: 1_200 }, () => null),
    });
    expect(report.diagnostics).toHaveLength(1_000);
    expect(report.summary.diagnostics).toBe(1_000);
    expect(
      report.diagnostics.some(
        (entry) => entry.source_pointer === "/resourceSpans/999",
      ),
    ).toBe(true);
    expect(
      report.diagnostics.some(
        (entry) => entry.source_pointer === "/resourceSpans/1000",
      ),
    ).toBe(false);
    expect(report.limitations.join(" ")).toContain(
      "200 diagnostics were omitted",
    );
  });

  it("counts later graph diagnostics after the shared allowance is full", () => {
    const report = parse({
      resourceSpans: [
        ...Array.from({ length: 1_000 }, () => null),
        { scopeSpans: [{ spans: [span({}), span({})] }] },
      ],
    });
    expect(report.diagnostics).toHaveLength(1_000);
    expect(report.spans).toHaveLength(2);
    expect(report.limitations.join(" ")).toContain("1 diagnostic was omitted");
  });
});
