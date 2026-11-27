import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { webNetworkCaptureSchema } from "../../../src/domain/webNetworkCapture.js";
import { protobufFrame, protobufHar } from "../../fixtures/protobufCapture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const body = Buffer.from([8, 1]);
const bodySha = createHash("sha256").update(body).digest("hex");
const hiddenMime = "application/json;type=excluded-declaration";
const automaticProfiles = [
  ['application/protobuf;encoding="binary', "malformed media-type parameters"],
  [
    "application/protobuf;encoding=binary;encoding=json",
    "conflicting encoding parameters",
  ],
  ['Application/Protobuf;ENCODING="b\\inary";type="name;=value"', undefined],
] as const;

cliTest(
  "admits complete MIME facts without repairing malformed protobuf parameters through CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-protobuf-mime-admission-");
    const call = await cli.sharedMcpCall!();
    for (const [index, [mime, problem]] of automaticProfiles.entries()) {
      const path = join(root, `${index}.har`);
      const original = protobufHar(body, mime);
      await writeFile(path, original);
      const output = await cli.run({
        arguments: [
          "inspect-web-network-capture",
          path,
          "har",
          "--record",
          "0",
          "--json",
        ],
      });
      expect(output.exitCode, output.stdout + output.stderr).toBe(0);
      const evidence = parseEvidence(output.json);
      const report = webNetworkCaptureSchema.parse(evidence.normalized_result);
      expect(report.artifact).toMatchObject({
        path,
        sha256: createHash("sha256").update(original).digest("hex"),
      });
      expect(report.protobuf_coverage).toEqual({
        status: problem === undefined ? "complete" : "partial",
        selected_records: 1,
        inspected_records: 1,
      });
      if (problem === undefined)
        expect(report.records[0]?.protobuf?.[0]).toMatchObject({
          content_type: mime,
          framing: "raw",
          status: "complete",
          fields: [{ number: 1, value: "1" }],
        });
      else {
        expect(report.records[0]?.protobuf).toBeUndefined();
        expect(report.records[0]?.limitations).toContainEqual(
          expect.stringContaining(problem),
        );
      }
      expect(report.records[0]?.reported).toMatchObject({
        response: {
          content: { mimeType: mime, text: body.toString("base64") },
        },
      });
      expect(report.records[0]?.binary_fields).toContainEqual(
        expect.objectContaining({
          pointer: "/response/content/text",
          state: "retained",
          content_base64: body.toString("base64"),
          bytes: 2,
          sha256: bodySha,
        }),
      );
      const reply = await call("inspect_web_network_capture", {
        capture_path: path,
        format: "har",
        record_ordinals: [0],
      });
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      expect(parseEvidence(reply.structuredContent).evidence_id).toBe(
        evidence.evidence_id,
      );
      expect(await readFile(path, "utf8")).toBe(original);
    }
  },
);

cliTest(
  "keeps an excluded HAR MIME unknown beside a visible contradictory header through CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-protobuf-har-mime-unknown-",
    );
    const path = join(root, "capture.har");
    const original = protobufHar(
      body,
      hiddenMime,
      [],
      [{ name: "Content-Type", value: "application/protobuf" }],
    );
    await writeFile(path, original);
    const call = await cli.sharedMcpCall!();
    for (const framing of ["auto", "raw"] as const) {
      const output = await cli.run({
        arguments: [
          "inspect-web-network-capture",
          path,
          "har",
          "--record",
          "0",
          "--protobuf-framing",
          framing,
          "--sensitive-value",
          "excluded-declaration",
          "--json",
        ],
      });
      expect(output.exitCode, output.stdout + output.stderr).toBe(0);
      const evidence = parseEvidence(output.json);
      const report = webNetworkCaptureSchema.parse(evidence.normalized_result);
      expect(report.records[0]?.reported).toMatchObject({
        response: {
          headers: [{ name: "Content-Type", value: "application/protobuf" }],
          content: { mimeType: null },
        },
      });
      expect(report.records[0]?.binary_fields).toContainEqual(
        expect.objectContaining({
          state: "retained",
          bytes: 2,
          sha256: bodySha,
        }),
      );
      if (framing === "auto") {
        expect(report.protobuf_coverage?.status).toBe("partial");
        expect(report.records[0]?.protobuf).toBeUndefined();
        expect(report.records[0]?.limitations).toContainEqual(
          expect.stringContaining(
            "MIME metadata is excluded, conflicting or unavailable",
          ),
        );
      } else {
        expect(report.protobuf_coverage?.status).toBe("complete");
        expect(report.records[0]?.protobuf?.[0]).toMatchObject({
          content_type: null,
          framing: "raw",
          fields: [{ number: 1, value: "1" }],
        });
      }
      const reply = await call("inspect_web_network_capture", {
        capture_path: path,
        format: "har",
        record_ordinals: [0],
        sensitive_values: ["excluded-declaration"],
        protobuf: { framing },
      });
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      expect(parseEvidence(reply.structuredContent).evidence_id).toBe(
        evidence.evidence_id,
      );
    }
    expect(await readFile(path, "utf8")).toBe(original);
  },
);

cliTest(
  "sanitizes visible HAR transport credentials independently of MIME interpretation",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-protobuf-har-transport-");
    const path = join(root, "capture.har");
    const trailer = protobufFrame(
      Buffer.from("authorization: Bearer fixture-only\r\n"),
      128,
    );
    const transport = { name: "Content-Type", value: "application/grpc-web" };
    const raw = { name: "Content-Type", value: "application/protobuf" };
    const archive = JSON.parse(
      protobufHar(trailer, hiddenMime, [trailer, trailer, body], [transport]),
    ) as {
      log: {
        entries: {
          response: {
            content: { mimeType: string };
            headers: { name: string; value: string }[];
          };
        }[];
      };
    };
    for (const entry of archive.log.entries.slice(1))
      entry.response.content.mimeType = raw.value;
    archive.log.entries[2]!.response.headers.unshift(raw);
    const original = JSON.stringify(archive);
    await writeFile(path, original);
    const call = await cli.sharedMcpCall!();
    for (const protobuf of [
      { framing: "auto", body_pointers: ["/response/content/text"] },
      { framing: "raw" },
      { body_pointers: [] },
    ]) {
      const selected = protobuf.body_pointers?.length !== 0;
      const reply = await call("inspect_web_network_capture", {
        capture_path: path,
        format: "har",
        record_ordinals: [0, 1, 2, 3],
        sensitive_values: ["excluded-declaration"],
        protobuf,
      });
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      const report = webNetworkCaptureSchema.parse(
        parseEvidence(reply.structuredContent).normalized_result,
      );
      expect(report.protobuf_coverage).toEqual({
        status: selected ? "partial" : "complete",
        selected_records: 4,
        inspected_records: 4,
      });
      expect(report.records.map((record) => record.ordinal)).toEqual([
        0, 1, 2, 3,
      ]);
      for (const [ordinal, record] of report.records.slice(0, 3).entries()) {
        expect(
          record.protobuf,
          `record ${ordinal} (${protobuf.framing ?? "unselected"})`,
        ).toBeUndefined();
        expect(record.reported).toMatchObject({
          response: {
            headers: archive.log.entries[ordinal]!.response.headers,
            content: { mimeType: ordinal === 0 ? null : raw.value, text: null },
          },
        });
        expect(record.binary_fields).toContainEqual(
          expect.objectContaining({
            pointer: "/response/content/text",
            state: "redacted",
            content_base64: null,
            sha256: null,
          }),
        );
        expect(record.redactions).toContainEqual({
          pointer: "/response/content/text",
          reason: "transport-credential",
        });
      }
      if (selected)
        expect(report.records[3]?.protobuf?.[0]).toMatchObject({
          content_type: raw.value,
          framing: "raw",
          fields: [{ number: 1, value: "1" }],
        });
      else expect(report.records[3]?.protobuf).toBeUndefined();
      expect(report.records[3]?.binary_fields).toContainEqual(
        expect.objectContaining({
          pointer: "/response/content/text",
          state: "retained",
          content_base64: body.toString("base64"),
          sha256: bodySha,
        }),
      );
    }
    expect(await readFile(path, "utf8")).toBe(original);
  },
);

cliTest(
  "retains caller-selected raw interpretation and the invalid recorded MIME through CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-protobuf-mime-explicit-");
    const path = join(root, "capture.har");
    const mime = 'application/protobuf;encoding="binary';
    const original = protobufHar(body, mime);
    await writeFile(path, original);
    const output = await cli.run({
      arguments: [
        "inspect-web-network-capture",
        path,
        "har",
        "--record",
        "0",
        "--protobuf-framing",
        "raw",
        "--json",
      ],
    });
    expect(output.exitCode, output.stdout + output.stderr).toBe(0);
    const evidence = parseEvidence(output.json);
    const report = webNetworkCaptureSchema.parse(evidence.normalized_result);
    expect(report.protobuf_coverage?.status).toBe("complete");
    expect(report.records[0]?.protobuf?.[0]).toMatchObject({
      content_type: mime,
      framing: "raw",
      fields: [{ number: 1, value: "1" }],
    });
    expect(report.records[0]?.limitations).toContainEqual(
      expect.stringContaining("invalid MIME declaration"),
    );
    const call = await cli.sharedMcpCall!();
    const reply = await call("inspect_web_network_capture", {
      capture_path: path,
      format: "har",
      record_ordinals: [0],
      protobuf: { framing: "raw" },
    });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    expect(parseEvidence(reply.structuredContent).evidence_id).toBe(
      evidence.evidence_id,
    );
    expect(await readFile(path, "utf8")).toBe(original);
  },
);
