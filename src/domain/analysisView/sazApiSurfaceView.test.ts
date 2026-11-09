import { expect, it } from "vitest";
import {
  analysisViewCaptureFixture,
  analysisViewCaptureEvidence,
} from "../../../tests/fixtures/analysisView.js";
import type { JsonValue } from "../jsonValue.js";
import { projectAnalysisView } from "./analysisView.js";

const project = (reported: JsonValue[], sensitiveValueCount = 0) => {
  const capture = analysisViewCaptureFixture();
  capture.format = "saz";
  capture.artifact.path = "/fixtures/surface.saz";
  capture.total_records = reported.length;
  capture.records = reported.map((value, ordinal) => ({
    ordinal,
    location: { kind: "archive-members", members: [`raw/${ordinal}_c.txt`] },
    reported: value,
    binary_fields: [],
    numeric_literals: [],
    redactions: [],
    limitations: [],
  }));
  const parent = analysisViewCaptureEvidence(capture);
  return projectAnalysisView(
    {
      evidenceId: parent.evidence_id,
      predicateType: parent.predicate_type,
      operation: parent.operation,
      normalizedResult: parent.normalized_result,
      limitations: [],
      parameters: { sensitive_value_count: sensitiveValueCount },
    },
    { kind: "api-surface", offset: 0, limit: 50 },
  );
};
const request = { method: "GET", url: "https://api.test/items/1?omit=value" };

it("groups SAZ request lines with textual statuses and ordered response headers", () => {
  const result = project([
    {
      request,
      response: {
        status: "200",
        headers: [
          { name: "Content-Type", value: " Application/JSON; charset=utf-8" },
        ],
      },
    },
    {
      request: { ...request, url: "https://api.test/items/2" },
      response: {
        status: "404",
        headers: [{ name: "content-TYPE", value: "text/plain" }],
      },
    },
  ]);
  expect(result).toMatchObject({
    ok: true,
    value: {
      records: { examined: 2, total: 2, excluded: 0 },
      groups: [
        {
          method: "GET",
          origin: "https://api.test",
          path_template: "/items/{numeric}",
          record_ordinals: [0, 1],
          statuses: [200, 404],
          content_types: ["application/json", "text/plain"],
          flags: ["mixed-statuses", "mixed-content-types"],
          templated_segments: [
            {
              segment_index: 1,
              rule: "numeric",
              basis: "inferred",
              observed_values: ["1", "2"],
            },
          ],
        },
      ],
      unknowns: [],
    },
  });
  expect(JSON.stringify(result)).not.toContain("omit");
});

it.each([
  "\r\n application/json",
  "\n\tapplication/json",
  "\r\n \t\r\n\tApplication/JSON\r\n ; charset=utf-8",
  " application/json\n\t ",
])(
  "uses parser-produced unfolded SAZ fields without changing source: %j",
  (value) => {
    const reported = {
      request,
      response: {
        status: "200",
        headers: [
          { name: "Content-Type", value, value_unfolded: " application/json" },
        ],
      },
    };
    const before = structuredClone(reported);
    expect(project([reported])).toMatchObject({
      ok: true,
      value: {
        groups: [{ statuses: [200], content_types: ["application/json"] }],
        unknowns: [],
      },
    });
    expect(reported).toEqual(before);
  },
);

it.each([
  null,
  { status: "200", headers: null },
  { status: "200", headers: [{ name: "Content-Type", value: null }] },
  {
    status: "200",
    headers: [
      { name: "Content-Type", value: "text/plain" },
      { name: "CONTENT-TYPE", value: "application/json" },
    ],
  },
  {
    status: "200",
    headers: [
      { name: "Content-Type", value: "text/plain" },
      { name: "CONTENT-TYPE", value: "text/plain" },
    ],
  },
  {
    status: "200",
    headers: [{ name: "Content-Type", value: "text/plain" }, null],
  },
  {
    status: "200",
    headers: [{ name: "Content-Type", value: "\u00a0text/plain" }],
  },
  ...[
    "\r application/json",
    "\n application/json",
    "\r\n application/json",
    "\napplication/json",
    "\r\napplication/json",
    "\n\u00a0application/json",
    "application/\r\n json",
    "application/json;\n charset=utf-8",
  ].map((value) => ({
    status: "200",
    headers: [{ name: "Content-Type", value }],
  })),
  {
    status: "200",
    headers: [
      {
        name: "Content-Type",
        value: "\r\n application/json;\n charset=utf-8",
        value_unfolded: " application/json;\n charset=utf-8",
      },
    ],
  },
])(
  "preserves unknown or ambiguous SAZ response content types: %j",
  (response) => {
    const result = project([{ request, response }]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        groups: [
          { statuses: response === null ? [] : [200], content_types: [] },
        ],
        unknowns: [
          "Some retained records have unavailable status or content type values.",
        ],
      },
    });
  },
);

it.each([null, "", "200.0", " 200", "200 OK", 200, "000"])(
  "does not invent a SAZ status from %j",
  (status) => {
    expect(
      project([
        {
          request,
          response: {
            status,
            headers: [{ name: "Content-Type", value: "text/plain" }],
          },
        },
      ]),
    ).toMatchObject({
      ok: true,
      value: { groups: [{ statuses: [], content_types: ["text/plain"] }] },
    });
  },
);

it("excludes relative, authority and asterisk targets without guessing from Host", () => {
  const result = project([
    ...["/items/1", "api.test:443", "*"].map((url) => ({
      request: {
        method: "GET",
        url,
        headers: [{ name: "Host", value: "api.test" }],
      },
    })),
    { request: null },
    { request: { method: "GET", url: null } },
  ]);
  expect(result).toMatchObject({
    ok: true,
    value: {
      groups: [],
      records: { examined: 5, total: 5, excluded: 5 },
      excluded_records: [
        { ordinal: 0, reason: "url-unparseable" },
        { ordinal: 1, reason: "url-unparseable" },
        { ordinal: 2, reason: "url-unparseable" },
        { ordinal: 3, reason: "request-unavailable" },
        { ordinal: 4, reason: "url-redacted" },
      ],
    },
  });
});

it("keeps the refusal for unretained sensitive declarations on SAZ parents", () => {
  expect(project([{ request }], 1)).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisUnsupportedTargetError",
      reason: "sensitive_values_unretained",
    },
  });
});
