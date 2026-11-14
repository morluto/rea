import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { expect } from "vitest";
import { z } from "zod";

import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import { peResourcesSchema } from "../../../src/domain/native/peResources.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const contract = BINARY_DIAGNOSTICS_TOOL_CONTRACTS.find(
  ({ name }) => name === "inspect_pe_resources",
);
if (contract === undefined) throw new Error("Missing PE resource contract");

const range = z.object({ offset: z.int(), bytes: z.int() });
const oracle = z
  .object({
    samples: z
      .array(
        z.object({
          name: z.string(),
          format: z.enum(["pe32", "pe32-plus"]),
          size: z.int(),
          sha256: z.string(),
          deflate_base64: z.string(),
          resources: z.array(
            z.object({
              index: z.int(),
              type: z.int(),
              name: z.int(),
              language: z.int(),
              offset: z.int(),
              size: z.int(),
              sha256: z.string(),
            }),
          ),
          groups: z.array(
            z.object({
              resource_index: z.int(),
              images: z.array(
                z.object({
                  location: range,
                  width: z.int(),
                  height: z.int(),
                  color_count: z.int(),
                  reserved: z.int(),
                  planes: z.int(),
                  bit_count: z.int(),
                  declared_bytes: z.int(),
                  resource_id: z.int(),
                  candidate_resource_indices: z.array(z.int()),
                  same_language_resource_index: z.int(),
                  size_matches: z.literal(true),
                }),
              ),
            }),
          ),
        }),
      )
      .length(2)
      .refine(
        (samples) => new Set(samples.map(({ format }) => format)).size === 2,
      ),
  })
  .parse(
    JSON.parse(
      await readFile(
        new URL("../../fixtures/pe-icon-producer/oracle.json", import.meta.url),
        "utf8",
      ),
    ),
  );

for (const sample of oracle.samples) {
  cliTest(
    `retains producer ${sample.format} large icon descriptors and language bindings`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-pe-icon-producer-");
      const path = join(root, sample.name);
      // Complete resource-only PE files emitted by GNU windres/ld, not rebuilt
      // with REA's authored PE fixture. Bound decoding of the recorded transport.
      const bytes = inflateSync(Buffer.from(sample.deflate_base64, "base64"), {
        maxOutputLength: 1024 * 1024,
      });
      expect(bytes.length).toBe(sample.size);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        sample.sha256,
      );
      expect(sample.groups).toHaveLength(2);
      expect(
        sample.groups
          .flatMap(({ images }) => images)
          .some(({ declared_bytes }) => declared_bytes > 65535),
      ).toBe(true);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-pe-resources", path, "--json"],
      });
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      const evidence = contract.outputSchema.parse(result.json);
      const report = peResourcesSchema.parse(evidence.normalized_result);
      expect(evidence.subject?.digest.sha256).toBe(sample.sha256);
      expect(report).toMatchObject({
        artifact: { path, bytes: sample.size, sha256: sample.sha256 },
        format: sample.format,
        coverage: { status: "complete", resources: sample.resources.length },
      });
      expect(
        report.resources.map(({ index, type, name, language, payload }) => ({
          index,
          type: type.kind === "id" ? type.id : null,
          name: name.kind === "id" ? name.id : null,
          language: language.kind === "id" ? language.id : null,
          offset: payload.location.offset,
          size: payload.location.bytes,
          sha256: payload.sha256,
        })),
      ).toEqual(sample.resources);
      // Original encoded dimensions (0 denotes 256) are intentional. The DWORD
      // byte length must remain exact and bind the correct same-language RT_ICON.
      expect(report.icon_groups).toEqual(sample.groups);
      expect((await readFile(path)).equals(bytes)).toBe(true);
    },
  );
}
