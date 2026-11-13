import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { protobufFieldSchema } from "../../../src/domain/protobufWire.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { webNetworkCaptureSchema } from "../../../src/domain/webNetworkCapture.js";
import { protobufHar } from "../../fixtures/protobufCapture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const oracleSchema = z.object({
  producer: z.literal("google.protobuf 6.33.5"),
  samples: z.array(
    z.object({
      encoding: z.enum(["packed", "unpacked"]),
      descriptor_base64: z.string(),
      body_base64: z.string(),
      body_sha256: z.string(),
      fields: z.array(
        protobufFieldSchema.pick({
          number: true,
          wire_type: true,
          offset: true,
          bytes: true,
          payload_offset: true,
          payload_bytes: true,
          value: true,
          schema_name: true,
          schema_type: true,
          schema_status: true,
          schema_value: true,
        }),
      ),
    }),
  ),
});
const oracle = oracleSchema.parse(
  JSON.parse(
    await readFile(
      new URL("../../fixtures/protobuf-scalars/oracle.json", import.meta.url),
      "utf8",
    ),
  ),
);

cliTest(
  "preserves independently produced scalar values and wire occurrences across packing options through CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-protobuf-scalar-oracle-");
    const capturePath = join(root, "scalars.har");
    const bodies = oracle.samples.map((sample) =>
      Buffer.from(sample.body_base64, "base64"),
    );
    const first = bodies[0];
    if (first === undefined) throw new Error("Missing scalar wire oracle");
    await writeFile(
      capturePath,
      protobufHar(first, "application/x-protobuf", bodies.slice(1)),
    );
    const call = await cli.sharedMcpCall!();
    for (const descriptor of oracle.samples) {
      const descriptorPath = join(root, `${descriptor.encoding}.pb`);
      const descriptorBytes = Buffer.from(
        descriptor.descriptor_base64,
        "base64",
      );
      await writeFile(descriptorPath, descriptorBytes);
      // One CLI and one SDK MCP request cover all four schema/wire combinations.
      let output: unknown;
      if (descriptor.encoding === "packed") {
        const result = await cli.run({
          arguments: [
            "inspect-web-network-capture",
            capturePath,
            "har",
            "--record",
            "0",
            "--record",
            "1",
            "--protobuf-schema",
            descriptorPath,
            "--protobuf-message",
            "oracle.Scalars",
            "--json",
          ],
        });
        expect(result.exitCode, result.stdout + result.stderr).toBe(0);
        output = result.json;
      } else {
        const response = await call("inspect_web_network_capture", {
          capture_path: capturePath,
          format: "har",
          record_ordinals: [0, 1],
          protobuf: {
            schema: {
              descriptor_set_path: descriptorPath,
              message_type: "oracle.Scalars",
            },
          },
        });
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        output = response.structuredContent;
      }
      const report = webNetworkCaptureSchema.parse(
        parseEvidence(output).normalized_result,
      );
      expect(report.protobuf_coverage).toMatchObject({
        status: "complete",
        inspected_records: 2,
      });
      expect(report.records).toHaveLength(2);
      for (const [index, sample] of oracle.samples.entries()) {
        const body = report.records[index]?.protobuf?.[0];
        expect(body).toMatchObject({
          body_sha256: sample.body_sha256,
          status: "complete",
          framing: "raw",
          schema: {
            descriptor_set_sha256: createHash("sha256")
              .update(descriptorBytes)
              .digest("hex"),
          },
        });
        expect(body?.fields).toHaveLength(sample.fields.length);
        for (const [fieldIndex, expected] of sample.fields.entries()) {
          const actual = body?.fields[fieldIndex];
          expect(
            actual,
            `${descriptor.encoding} schema / ${sample.encoding} wire / ${expected.schema_name}`,
          ).toMatchObject(expected);
          // Packed fields have no single raw integer; a schema must not invent one.
          expect(actual?.value).toBe(expected.value);
        }
      }
    }
  },
);
