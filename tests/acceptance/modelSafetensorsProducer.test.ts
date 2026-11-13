import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";

import { INSPECT_MODEL_ARTIFACT_CONTRACT } from "../../src/contracts/model/modelToolContracts.js";
import { modelArtifactSchema } from "../../src/domain/model/modelArtifact.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const oracle = z
  .object({
    file_base64: z.string(),
    file_size: z.int(),
    sha256: z.string(),
    header_sha256: z.string(),
    tensor_data_offset: z.int(),
    metadata: z.record(z.string(), z.string()),
    tensors: z.array(
      z.object({
        name: z.string(),
        type: z.string(),
        shape: z.array(z.string()),
        parameter_count: z.string(),
        json_pointer: z.string(),
        data_offset: z.int(),
        file_offset: z.int(),
        byte_length: z.int(),
      }),
    ),
  })
  .parse(
    JSON.parse(
      await readFile(
        new URL(
          "../fixtures/safetensors-producer/oracle.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );

cliTest(
  "preserves the Rust safetensors producer's mixed tensor storage and provenance",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-safetensors-producer-");
    const path = join(root, "producer.safetensors");
    // The complete bytes are emitted by Rust serialize and independently read by
    // Rust deserialize. Do not rebuild this carrier with REA's fixture writer.
    const bytes = Buffer.from(oracle.file_base64, "base64");
    expect(bytes.length).toBe(oracle.file_size);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      oracle.sha256,
    );
    expect(oracle.tensors).toHaveLength(20);
    expect(new Set(oracle.tensors.map(({ type }) => type)).size).toBe(18);
    await writeFile(path, bytes);
    for (const hash of ["header", "full"] as const) {
      const result = await cli.run({
        arguments: [
          "inspect-model-artifact",
          path,
          "--detail",
          "complete",
          "--hash",
          hash,
          "--json",
        ],
      });
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      const report = modelArtifactSchema.parse(
        INSPECT_MODEL_ARTIFACT_CONTRACT.outputSchema.parse(result.json)
          .normalized_result,
      );
      expect(report.artifact).toMatchObject({
        path,
        file_size: oracle.file_size,
        header_sha256: oracle.header_sha256,
        sha256: hash === "full" ? oracle.sha256 : null,
      });
      expect(report).toMatchObject({
        format: "safetensors",
        tensor_data_offset: oracle.tensor_data_offset,
        coverage: {
          header: "complete",
          tensor_data: "not-interpreted",
          tensor_ranges: "complete",
          storage_sizes: "complete",
        },
      });
      expect(report.metadata.map(({ key, value }) => [key, value])).toEqual(
        Object.entries(oracle.metadata),
      );
      expect(
        report.tensors.map(
          ({
            name,
            type,
            shape,
            parameter_count,
            json_pointer,
            data_offset,
            file_offset,
            byte_length,
          }) => ({
            name,
            type,
            shape,
            parameter_count,
            json_pointer,
            data_offset,
            file_offset,
            byte_length,
          }),
        ),
      ).toEqual(oracle.tensors);
      for (const tensor of report.tensors) {
        expect(tensor).toMatchObject({
          source_offset: 8,
          source_length: oracle.tensor_data_offset - 8,
          byte_length_state: "declared",
          storage_validation: "consistent",
        });
      }
      expect(report.totals).toMatchObject({
        parameter_count: oracle.tensors
          .reduce((sum, tensor) => sum + BigInt(tensor.parameter_count), 0n)
          .toString(),
        tensor_bytes: oracle.tensors.reduce(
          (sum, tensor) => sum + tensor.byte_length,
          0,
        ),
      });
    }
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);
