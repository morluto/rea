import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../../../tests/fixtures/temporaryDirectory.js";
import {
  protobufCaptureDescriptor,
  protobufFrame,
} from "../../../../tests/fixtures/protobufCapture.js";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { ArtifactResourceScope } from "../../../resources/ArtifactResourceScope.js";
import {
  inspectWebNetworkCaptureInputSchema,
  type WebNetworkCapture,
} from "../../../domain/webNetworkCapture.js";
import {
  prepareCaptureProtobuf,
  decodeCaptureProtobuf,
} from "./ProtobufCapture.js";

const binary = (pointer: string, bytes: Buffer) => ({
  pointer,
  representation: "producer-bytes" as const,
  state: "retained" as const,
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  content_base64: bytes.toString("base64"),
});

const captureWithBody = (
  declaration: string | readonly string[],
  body: Buffer,
): WebNetworkCapture => {
  const types = typeof declaration === "string" ? [declaration] : declaration;
  return {
    artifact: { path: "/fixture.mitm", bytes: 100, sha256: "a".repeat(64) },
    decoder: { id: "fixture", name: "Native producer facts", version: "1" },
    container: {
      reported: null,
      numeric_literals: [],
      redactions: [],
      records_pointer: "/flows",
    },
    format: "mitmproxy",
    total_records: 1,
    runtime_attribution: "unknown",
    limitations: [],
    records: [
      {
        ordinal: 0,
        location: { kind: "byte-range", offset: 0, bytes: 100 },
        reported: {
          response: { headers: types.map(() => [null, null]), content: null },
        },
        binary_fields: [
          ...types.flatMap((type, index) => [
            binary(
              `/response/headers/${index}/0`,
              Buffer.from(index === 0 ? "content-type" : "Content-Type"),
            ),
            binary(`/response/headers/${index}/1`, Buffer.from(type)),
          ]),
          binary("/response/content", body),
        ],
        numeric_literals: [],
        redactions: [],
        limitations: [],
      },
    ],
  };
};

const decode = async (
  capture: WebNetworkCapture,
  framing: "auto" | "raw" = "auto",
) => {
  const input = inspectWebNetworkCaptureInputSchema.parse({
    capture_path: capture.artifact.path,
    format: capture.format,
    record_ordinals: [0],
    protobuf: { framing },
  });
  const resources = new ArtifactResourceScope();
  try {
    const prepared = await prepareCaptureProtobuf(capture, input);
    await decodeCaptureProtobuf(capture, input, resources, prepared);
  } finally {
    await resources.close();
  }
};

it("restricts framing overrides to native body facts while preserving header bytes", async () => {
  const payload = Buffer.from([8, 1]);
  const body = Buffer.alloc(5 + payload.length);
  body.writeUInt32BE(payload.length, 1);
  payload.copy(body, 5);
  const report = captureWithBody("application/grpc", body);
  const headers = report.records[0]!.binary_fields.slice(0, 2);
  const input = inspectWebNetworkCaptureInputSchema.parse({
    capture_path: report.artifact.path,
    format: report.format,
    record_ordinals: [0],
    protobuf: { framing: "grpc" },
  });
  const resources = new ArtifactResourceScope();
  try {
    const prepared = await prepareCaptureProtobuf(report, input);
    await decodeCaptureProtobuf(report, input, resources, prepared);
  } finally {
    await resources.close();
  }
  expect(report.records[0]?.protobuf).toMatchObject([
    {
      pointer: "/response/content",
      status: "complete",
      fields: [{ number: 1, value: "1" }],
    },
  ]);
  expect(report.records[0]?.protobuf).toHaveLength(1);
  expect(report.records[0]?.binary_fields.slice(0, 2)).toEqual(headers);
  expect(report.protobuf_coverage?.status).toBe("complete");
});

it.each([false, true])(
  "admits equivalent default binary profiles in repeated byte headers (reverse=%s)",
  async (reverse) => {
    const types = [
      "Application/Protobuf;type=left",
      'application/protobuf;ENCODING="binary";type="right;=value"',
    ];
    if (reverse) types.reverse();
    const report = captureWithBody(types, Buffer.from([8, 1]));
    const record = report.records[0]!;
    const retained = structuredClone(record.binary_fields);
    await decode(report);
    expect(report.protobuf_coverage?.status).toBe("complete");
    expect(record.protobuf?.[0]).toMatchObject({
      content_type: types[0],
      framing: "raw",
      fields: [{ number: 1, value: "1" }],
    });
    expect(record.binary_fields).toEqual(retained);
  },
);

it.each([false, true])(
  "keeps incompatible repeated MIME headers unknown (reverse=%s)",
  async (reverse) => {
    const types = [
      "application/protobuf",
      "application/protobuf;encoding=json",
    ];
    if (reverse) types.reverse();
    const report = captureWithBody(types, Buffer.from([8, 1]));
    const record = report.records[0]!;
    const retained = structuredClone(record.binary_fields);
    await decode(report);
    expect(report.protobuf_coverage?.status).toBe("partial");
    expect(record.protobuf).toBeUndefined();
    expect(record.limitations).toContainEqual(
      expect.stringContaining(
        "MIME metadata is excluded, conflicting or unavailable",
      ),
    );
    expect(record.binary_fields).toEqual(retained);
  },
);

it.each(["auto", "raw"] as const)(
  "preserves declared gRPC credential exclusions after MIME refusal with %s framing",
  async (framing) => {
    const invalid = 'application/grpc-web;note="unterminated';
    const valid = "application/grpc-web";
    for (const types of [[invalid], [valid, invalid], [invalid, valid]]) {
      const report = captureWithBody(
        types,
        protobufFrame(
          Buffer.from("authorization: Bearer fixture-only\r\n"),
          128,
        ),
      );
      const record = report.records[0]!;
      const headers = structuredClone(
        record.binary_fields.filter(({ pointer }) =>
          pointer.includes("/headers/"),
        ),
      );
      await decode(report, framing);
      expect(report.protobuf_coverage?.status, types.join(" / ")).toBe(
        "partial",
      );
      expect(record.protobuf).toBeUndefined();
      expect(
        record.binary_fields.find(
          ({ pointer }) => pointer === "/response/content",
        ),
      ).toMatchObject({
        state: "redacted",
        content_base64: null,
        sha256: null,
      });
      expect(record.redactions).toContainEqual({
        pointer: "/response/content",
        reason: "transport-credential",
      });
      expect(
        record.binary_fields.filter(({ pointer }) =>
          pointer.includes("/headers/"),
        ),
      ).toEqual(headers);
    }
  },
);

it.each([
  "application/protobuf; encoding=json",
  "application/protobuf; charset=utf-8",
  "application/protobuf; version=1",
])(
  "keeps illegal reserved MIME profiles undecoded and partial: %s",
  async (contentType) => {
    const report = captureWithBody(contentType, Buffer.from([8, 1]));
    const retained = structuredClone(report.records[0]!.binary_fields);
    await decode(report);
    expect(report.records[0]?.protobuf).toBeUndefined();
    expect(report.protobuf_coverage?.status).toBe("partial");
    expect(report.records[0]?.limitations).toContainEqual(
      expect.stringContaining("MIME profile"),
    );
    expect(report.records[0]?.binary_fields).toEqual(retained);
  },
);
it.each([
  "application/protobuf",
  'application/protobuf; encoding="binary"',
  'application/protobuf; type="example.Message"',
])(
  "admits binary MIME controls and non-encoding parameters: %s",
  async (contentType) => {
    const report = captureWithBody(contentType, Buffer.from([8, 1]));
    await decode(report);
    expect(report.records[0]?.protobuf?.[0]).toMatchObject({
      status: "complete",
      fields: [{ number: 1, value: "1" }],
    });
    expect(report.protobuf_coverage?.status).toBe("complete");
  },
);
it.each([
  {
    bytes: protobufCaptureDescriptor(),
    type: "capture.Missing",
    field: "message_type",
    reason: "invalid_value",
    message: "capture.Missing",
  },
  {
    bytes: Buffer.from([0x08, 0x80]),
    type: "capture.Message",
    field: "descriptor_set_path",
    reason: "invalid_format",
    message: "byte 0",
  },
])(
  "attributes schema admission to $field while preserving selected capture facts",
  async ({ bytes, type, field, reason, message }) => {
    const root = await createTestTempDirectory("rea-schema-admission-");
    const descriptor = join(root, "schema.pb");
    await writeFile(descriptor, bytes);
    const report = captureWithBody("application/protobuf", Buffer.from([8, 1]));
    const retained = structuredClone(report.records);
    const input = inspectWebNetworkCaptureInputSchema.parse({
      capture_path: report.artifact.path,
      format: report.format,
      record_ordinals: [0],
      protobuf: {
        schema: { descriptor_set_path: descriptor, message_type: type },
      },
    });
    const resources = new ArtifactResourceScope();
    try {
      const prepared = await prepareCaptureProtobuf(report, input);
      await expect(
        decodeCaptureProtobuf(report, input, resources, prepared),
      ).rejects.toMatchObject({
        _tag: "AnalysisInputError",
        issues: [
          {
            path: ["protobuf", "schema", field],
            reason,
            message: expect.stringContaining(message),
          },
        ],
      });
      expect(report.records).toEqual(retained);
      expect(report.protobuf_coverage).toMatchObject({
        status: "partial",
        inspected_records: 0,
      });
    } finally {
      await resources.close();
    }
  },
);
