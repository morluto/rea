import { expect, it, vi } from "vitest";
import { changedEvidenceSubject } from "../../../tests/fixtures/evidenceSubject.js";
import { createEvidence } from "../evidence.js";
import {
  freezeJsonSnapshot,
  isImmutableJsonSnapshot,
} from "../immutableJson.js";
import * as webNetworkCapture from "../webNetworkCapture.js";
import { projectAnalysisView } from "./analysisView.js";
import * as protobufCaptureView from "./protobufCaptureView.js";

const capture = async () => {
  const report = webNetworkCapture.webNetworkCaptureSchema.parse({
    artifact: { path: "/recordings/a.har", bytes: 100, sha256: "b".repeat(64) },
    decoder: {
      id: "projection-fixture",
      name: "Original projection facts",
      version: "1",
    },
    container: {
      reported: null,
      numeric_literals: [],
      redactions: [],
      records_pointer: "/log/entries",
    },
    format: "har",
    total_records: 1,
    runtime_attribution: "unknown",
    limitations: [],
    records: [
      {
        ordinal: 0,
        location: { kind: "json-pointer", pointer: "/log/entries/0" },
        reported: null,
        binary_fields: [],
        numeric_literals: [],
        redactions: [],
        limitations: [],
        protobuf: [
          {
            decoder: "rea-protobuf-wire-v1",
            pointer: "/response/content/text",
            content_type: "application/grpc-web+proto",
            body_sha256: "c".repeat(64),
            framing: "grpc-web",
            offset_basis: "retained-body",
            decoded_bytes: 37,
            status: "complete",
            examined_bytes: 37,
            limitations: [],
            frames: [
              {
                index: 0,
                kind: "data",
                offset: 0,
                payload_offset: 5,
                bytes: 11,
                compressed: false,
                status: "complete",
                examined_bytes: 11,
              },
              {
                index: 1,
                kind: "trailer",
                offset: 16,
                payload_offset: 21,
                bytes: 16,
                compressed: false,
                status: "complete",
                examined_bytes: 16,
              },
            ],
            fields: [
              {
                index: 0,
                frame_index: 0,
                parent_index: null,
                field_id: "offset:5",
                parent_field_id: null,
                number: 1,
                wire_type: "len",
                offset: 5,
                bytes: 7,
                payload_offset: 7,
                payload_bytes: 5,
                text: "hello",
                interpretations: ["utf8-string", "packed-varint", "bytes"],
              },
              {
                index: 1,
                frame_index: 0,
                parent_index: null,
                field_id: "offset:12",
                parent_field_id: null,
                number: 2,
                wire_type: "len",
                offset: 12,
                bytes: 4,
                payload_offset: 14,
                payload_bytes: 2,
              },
            ],
          },
        ],
      },
    ],
  });
  const evidence = createEvidence(
    { ...report.artifact, sha256: "b".repeat(64), format: "file" },
    report.decoder,
    {
      operation: "inspect_web_network_capture",
      parameters: { record_ordinals: [0] },
      result: report,
      confidence: "observed",
      authority: "historical-reference",
    },
  );
  return {
    report,
    parent: {
      predicateType: evidence.predicate_type,
      evidenceId: evidence.evidence_id,
      operation: evidence.operation,
      normalizedResult: report,
      subject: evidence.subject,
      limitations: evidence.limitations,
    },
  };
};

it("keeps coordinate identity and coverage with empty fields, batch filters and offset paging", async () => {
  const { parent } = await capture();
  const viewed = projectAnalysisView(parent, {
    kind: "protobuf",
    collection: "fields",
    field_ids: ["offset:5", "offset:12"],
    fields: [],
    offset: 1,
    limit: 1,
  });
  if (!viewed.ok) throw viewed.error;
  expect(viewed.value).toMatchObject({
    kind: "protobuf",
    coverage: { total: 2, examined: 1, exhausted: true },
    items: [
      {
        field_id: "offset:12",
        record_ordinal: 0,
        body_pointer: "/response/content/text",
        body_status: "complete",
        offset_basis: "retained-body",
      },
    ],
  });
  const empty = projectAnalysisView(parent, {
    kind: "protobuf",
    collection: "fields",
    field_numbers: [],
    offset: 0,
    limit: 1,
  });
  if (!empty.ok) throw empty.error;
  expect(empty.value).toMatchObject({
    items: [],
    coverage: { total: 0, exhausted: true },
  });
});

it("omits large values by default, returns requested text inline and preserves parser uncertainty", async () => {
  const { parent, report } = await capture();
  const brief = projectAnalysisView(parent, {
    kind: "protobuf",
    collection: "fields",
    offset: 0,
    limit: 1,
  });
  if (!brief.ok) throw brief.error;
  expect(brief.value).toMatchObject({
    items: [{ interpretations: ["utf8-string", "packed-varint", "bytes"] }],
  });
  expect(JSON.stringify(brief.value)).not.toContain('"hello"');
  const preview = projectAnalysisView(parent, {
    kind: "capture",
    detail: "preview",
    offset: 0,
    limit: 1,
  });
  if (!preview.ok) throw preview.error;
  expect(preview.value).toMatchObject({
    items: [
      {
        protobuf_summary: {
          bodies: 1,
          frames: 2,
          fields: 2,
          incomplete_bodies: 0,
        },
      },
    ],
  });
  expect(JSON.stringify(preview.value)).not.toContain('"field_id"');
  report.records[0]!.protobuf![0]!.status = "partial";
  const full = projectAnalysisView(parent, {
    kind: "protobuf",
    collection: "fields",
    fields: ["text"],
    offset: 0,
    limit: 1,
  });
  if (!full.ok) throw full.error;
  expect(full.value).toMatchObject({
    source_status: "partial",
    items: [{ text: "hello", body_status: "partial" }],
  });
  const changedSubject = projectAnalysisView(
    {
      ...parent,
      subject: changedEvidenceSubject(parent.subject, {
        sha256: "e".repeat(64),
      }),
    },
    { kind: "protobuf", collection: "bodies", offset: 0, limit: 1 },
  );
  expect(changedSubject.ok).toBe(false);
  report.records[0]!.protobuf![0]!.fields[0]!.offset = 1000;
  expect(
    projectAnalysisView(parent, {
      kind: "protobuf",
      collection: "fields",
      offset: 0,
      limit: 1,
    }).ok,
  ).toBe(false);
});

it("reuses one frozen capture snapshot across repeated webNetworkCapture and protobuf pages", async () => {
  const { report, parent } = await capture();
  const sharedReported = {
    request: { method: "GET", url: "https://example.test" },
  };
  const record0 = report.records[0]!;
  const multi = webNetworkCapture.webNetworkCaptureSchema.parse({
    ...report,
    total_records: 2,
    records: [
      { ...record0, ordinal: 0, reported: sharedReported },
      {
        ...record0,
        ordinal: 1,
        location: { kind: "json-pointer", pointer: "/log/entries/1" },
        reported: sharedReported,
      },
    ],
  });
  const sealedSnapshot = freezeJsonSnapshot({
    ...multi,
    records: multi.records.map((entry) => ({
      ...entry,
      reported: sharedReported,
    })),
  });
  const sealedParent = {
    ...parent,
    sealedResult: true,
    normalizedResult: sealedSnapshot,
  };
  const unsealedParent = {
    ...parent,
    sealedResult: false,
    normalizedResult: structuredClone(multi),
  };

  const parseSpy = vi.spyOn(
    webNetworkCapture.webNetworkCaptureSchema,
    "safeParse",
  );
  const passedReports: unknown[] = [];
  const originalProject = protobufCaptureView.projectProtobufCapturePage;
  const protobufSpy = vi
    .spyOn(protobufCaptureView, "projectProtobufCapturePage")
    .mockImplementation((parsedReport, view) => {
      passedReports.push(parsedReport);
      return originalProject(parsedReport, view);
    });
  try {
    const summary = projectAnalysisView(sealedParent, { kind: "summary" });
    const page1 = projectAnalysisView(sealedParent, {
      kind: "protobuf",
      collection: "fields",
      field_numbers: [1, 2],
      offset: 0,
      limit: 2,
    });
    const page2 = projectAnalysisView(
      { ...sealedParent },
      {
        kind: "protobuf",
        collection: "fields",
        field_numbers: [1, 2],
        offset: 2,
        limit: 2,
      },
    );
    const preview = projectAnalysisView(sealedParent, {
      kind: "capture",
      detail: "preview",
      offset: 0,
      limit: 2,
    });
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(protobufSpy).toHaveBeenCalledTimes(2);
    expect(passedReports).toHaveLength(2);
    expect(isImmutableJsonSnapshot(passedReports[0])).toBe(true);
    expect(passedReports[1]).toBe(passedReports[0]);

    expect(summary).toEqual(
      projectAnalysisView(unsealedParent, { kind: "summary" }),
    );
    expect(page1).toEqual(
      projectAnalysisView(unsealedParent, {
        kind: "protobuf",
        collection: "fields",
        field_numbers: [1, 2],
        offset: 0,
        limit: 2,
      }),
    );
    expect(page2).toEqual(
      projectAnalysisView(unsealedParent, {
        kind: "protobuf",
        collection: "fields",
        field_numbers: [1, 2],
        offset: 2,
        limit: 2,
      }),
    );
    expect(preview).toEqual(
      projectAnalysisView(unsealedParent, {
        kind: "capture",
        detail: "preview",
        offset: 0,
        limit: 2,
      }),
    );
  } finally {
    parseSpy.mockRestore();
    protobufSpy.mockRestore();
  }
});
