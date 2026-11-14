import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { expect } from "vitest";
import { z } from "zod";

import { artifactInventoryResultSchema } from "../../src/domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const oracle = z
  .object({
    samples: z.array(
      z.object({
        mode: z.enum(["embedded", "offset", "position"]),
        size: z.int().positive(),
        sha256: z.string(),
        deflate_base64: z.string(),
        images: z.array(
          z.object({
            name: z.string(),
            load: z.string(),
            entry: z.string(),
            size: z.int().positive(),
            sha256: z.string(),
          }),
        ),
      }),
    ),
  })
  .parse(
    JSON.parse(
      await readFile(
        new URL("../fixtures/fit-producer/oracle.json", import.meta.url),
        "utf8",
      ),
    ),
  );

for (const sample of oracle.samples) {
  cliTest(
    `preserves producer FIT addresses above 2^53 with ${sample.mode} payloads`,
    async ({ cli }) => {
      const directory = await createTestTempDirectory("rea-fit-producer-");
      const path = join(directory, sample.mode + ".itb");
      // These are complete mkimage outputs, not a carrier rebuilt by a REA fixture.
      const bytes = inflateSync(Buffer.from(sample.deflate_base64, "base64"), {
        maxOutputLength: 128 * 1024,
      });
      expect(bytes.length).toBe(sample.size);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        sample.sha256,
      );
      await writeFile(path, bytes);
      const response = await cli.run({
        arguments: ["inspect-artifact", path, "--json"],
      });
      expect(response.exitCode, response.stdout + response.stderr).toBe(0);
      const inspection = artifactInspectionResultSchema.parse(
        parseEvidence(response.json).normalized_result,
      );
      const graph = artifactInventoryResultSchema.parse(
        inspection.substeps[0]?.evidence.normalized_result,
      );
      expect(graph.manifest.root_sha256).toBe(sample.sha256);
      expect(graph.manifest.root_format).toBe("fit");
      expect(graph.occurrences.map((row) => row.logical_path).sort()).toEqual(
        [".", ...sample.images.map(({ name }) => `images/${name}.bin`)].sort(),
      );
      for (const image of sample.images) {
        const row = graph.occurrences.find(
          ({ logical_path }) => logical_path === `images/${image.name}.bin`,
        );
        expect(row?.format_metadata).toMatchObject({
          kind: "fit-image",
          name: image.name,
          load: image.load,
          entry: image.entry,
          data_source:
            sample.mode === "embedded" ? "embedded" : `data-${sample.mode}`,
          hashes_verified: 2,
          hashes_unverified: 0,
          unreadable_fields: [],
        });
        expect(row?.declared_size).toBe(image.size);
        expect(
          graph.nodes.find(
            ({ artifact_id }) => artifact_id === row?.artifact_id,
          )?.sha256,
        ).toBe(image.sha256);
      }
    },
  );
}
