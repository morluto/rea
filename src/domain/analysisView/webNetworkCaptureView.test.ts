import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createEvidence } from "../evidence.js";
import { webNetworkCaptureSchema } from "../webNetworkCapture.js";
import { projectAnalysisView } from "./analysisView.js";

const capture = () => {
  const body = Buffer.from("original body");
  const artifact = {
    path: "/recordings/input.saz",
    sha256: "b".repeat(64),
    bytes: 100,
  };
  const decoder = { id: "fixture", name: "Fixture", version: "1" };
  const report = webNetworkCaptureSchema.parse({
    artifact,
    decoder,
    format: "saz",
    runtime_attribution: "unknown",
    limitations: [],
    container: {
      reported: { members: [] },
      numeric_literals: [],
      redactions: [],
      records_pointer: null,
    },
    total_records: 9,
    records: [7, 2].map((ordinal) => ({
      ordinal,
      location: { kind: "archive-members", members: [`raw/${ordinal}_c.txt`] },
      reported: {
        session_id: String(ordinal),
        time: null,
        request: {
          method: "POST",
          url: "https://example.invalid/a",
          body: body.toString(),
        },
      },
      binary_fields: [
        {
          pointer: "/request/body",
          representation: "producer-bytes",
          state: "retained",
          content_base64: body.toString("base64"),
          bytes: body.length,
          sha256: createHash("sha256").update(body).digest("hex"),
        },
      ],
      numeric_literals: [
        {
          pointer: "/time",
          producer_type: "json-number",
          literal: "9007199254740993",
        },
      ],
      redactions: [],
      limitations: [],
    })),
  });
  const evidence = createEvidence({ ...artifact, format: "file" }, decoder, {
    operation: "inspect_web_network_capture",
    parameters: { record_ordinals: [7, 2] },
    result: report,
    confidence: "observed",
    authority: "historical-reference",
  });
  return {
    report,
    parent: {
      evidenceId: evidence.evidence_id,
      operation: evidence.operation,
      normalizedResult: report,
      subject: evidence.subject,
      limitations: evidence.limitations,
    },
  };
};

it("keeps selected-record page coverage distinct from capture coverage and unsafe number absence", () => {
  const { parent, report } = capture();
  const summary = projectAnalysisView(parent, { kind: "summary" });
  expect(summary.ok && summary.value).toMatchObject({
    summary: { total_records: 9, retained_records: 2 },
    coverage: { examined: 2, total: 2 },
  });
  const preview = projectAnalysisView(parent, {
    kind: "capture",
    detail: "preview",
    offset: 0,
    limit: 1,
  });
  expect(preview.ok && preview.value).toMatchObject({
    items: [
      {
        ordinal: 7,
        reported: { time: null },
        numeric_literals: [{ pointer: "/time", literal: "9007199254740993" }],
      },
    ],
    coverage: { total: 2, examined: 1, next_offset: 1, exhausted: false },
  });
  expect(JSON.stringify(preview)).not.toContain("original body");
  expect(JSON.stringify(preview)).not.toContain("content_base64");
  const complete = projectAnalysisView(parent, {
    kind: "capture",
    detail: "complete",
    offset: 1,
    limit: 1,
  });
  expect(complete.ok && complete.value).toMatchObject({
    items: [report.records[1]],
    coverage: { total: 2, examined: 1, next_offset: null, exhausted: true },
  });
  const empty = projectAnalysisView(parent, {
    kind: "capture",
    detail: "preview",
    offset: 50,
    limit: 1,
  });
  expect(empty.ok && empty.value).toMatchObject({
    items: [],
    coverage: {
      status: "empty",
      total: 2,
      examined: 0,
      next_offset: null,
      exhausted: true,
    },
  });
});

it("retains explicitly unknown digests and rejects a different subject path", () => {
  const { parent, report } = capture();
  const unknown = projectAnalysisView(
    {
      ...parent,
      subject: null,
      normalizedResult: {
        ...report,
        artifact: { ...report.artifact, sha256: null },
      },
    },
    { kind: "summary" },
  );
  expect(unknown.ok && unknown.value).toMatchObject({
    artifact: { sha256: null },
  });
  expect(unknown.ok && unknown.value.unknowns.join(" ")).toContain(
    "excluded artifact digest",
  );
  if (parent.subject === null) throw new Error("Expected fixture subject");
  const mismatched = projectAnalysisView(
    {
      ...parent,
      subject: { ...parent.subject, local_path: "/different/source.saz" },
    },
    { kind: "summary" },
  );
  expect(mismatched.ok).toBe(false);
});

it("rejects invalid ordinal coverage in a borrowed parent", () => {
  const { parent, report } = capture();
  const result = projectAnalysisView(
    {
      ...parent,
      normalizedResult: {
        ...report,
        records: [report.records[0], report.records[0]],
      },
    },
    { kind: "summary" },
  );
  expect(result.ok).toBe(false);
});
