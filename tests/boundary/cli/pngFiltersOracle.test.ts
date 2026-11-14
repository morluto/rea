import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { digestCanonicalValue } from "../../../src/domain/canonicalDigest.js";
import { createWebScreenshotArtifact } from "../../../src/domain/webScreenshot.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const corpus = JSON.parse(
  await readFile(
    new URL("../../fixtures/pngFilters/vectors.json", import.meta.url),
    "utf8",
  ),
) as {
  vectors: {
    mode: string;
    reference: string;
    filtered: string;
    changed: string;
    delta: number;
  }[];
};

for (const vector of corpus.vectors) {
  cliTest(
    `compares independently decoded ${vector.mode} scanline filters against literal pixels`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-png-filter-oracle-");
      const artifacts = [vector.reference, vector.filtered, vector.changed].map(
        (encoded) =>
          createWebScreenshotArtifact(Buffer.from(encoded, "base64")),
      );
      const paths = artifacts.map((_, index) => join(root, `${index}.json`));
      for (const [index, artifact] of artifacts.entries())
        await writeFile(paths[index]!, JSON.stringify(artifact));

      for (const [index, expected] of [
        [
          1,
          {
            status: "identical",
            changed_pixels: 0,
            maximum_channel_delta: 0,
            changed_ratio: 0,
            mean_absolute_channel_delta: 0,
          },
        ],
        [
          2,
          {
            status: "different",
            changed_pixels: 1,
            maximum_channel_delta: vector.delta,
            changed_ratio: 1 / 36,
            mean_absolute_channel_delta: vector.delta / (36 * 4),
          },
        ],
      ] as const) {
        const result = await cli.run({
          arguments: [
            "compare-web-screenshots",
            paths[0]!,
            paths[index]!,
            "--json",
          ],
          environment: process.env,
        });
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.signal).toBeNull();
        expect(result.json).toMatchObject({
          operation: "compare_web_screenshots",
          confidence: "derived",
          authority: "analyst-inference",
          parameters: {
            before_artifact_sha256: artifacts[0]!.sha256,
            after_artifact_sha256: artifacts[index]!.sha256,
            comparison_input_sha256: digestCanonicalValue({
              before: artifacts[0]!,
              after: artifacts[index]!,
              channel_threshold: 0,
            }),
          },
          normalized_result: {
            ...expected,
            before: { width: 6, height: 6 },
            after: { width: 6, height: 6 },
            compared_pixels: 36,
            channel_threshold: 0,
          },
        });
      }
      for (const [index, artifact] of artifacts.entries())
        expect(await readFile(paths[index]!, "utf8")).toBe(
          JSON.stringify(artifact),
        );
    },
  );
}
