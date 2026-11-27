import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect } from "vitest";

import { artifactExtractionResultSchema } from "../../src/domain/artifactGraph.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "keeps each extracted file's occurrence limitations on that file",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-zip-case-extraction-");
    const archivePath = join(root, "case.zip");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    // 50 pairs that collide under case folding, as R8-shrunk resources do.
    for (let index = 0; index < 50; index += 1)
      for (const name of [
        `res/-A${String(index)}.xml`,
        `res/-a${String(index)}.xml`,
      ])
        await writer.add(name, new TextReader(name));
    await writeFile(archivePath, await writer.close());
    const output = join(root, "out");
    const extracted = await cli.run({
      arguments: [
        "extract-artifact",
        archivePath,
        "--output-root",
        output,
        "--json",
      ],
    });
    expect(extracted.exitCode, extracted.stdout + extracted.stderr).toBe(0);
    const extraction = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.json).normalized_result,
    );
    expect(extraction.artifacts).toHaveLength(100);
    expect(
      extraction.artifacts.find(
        ({ relative_path }) => relative_path === "res/-A0.xml",
      )?.limitations,
    ).toEqual([
      expect.stringContaining(
        "Logical path res/-A0.xml collides under English (en-US) Unicode case folding with res/-a0.xml",
      ),
    ]);
    // The extraction's own list counts them instead of repeating each one.
    expect(extraction.limitations).toContain(
      "100 extracted file(s) carry their inventory occurrence's limitations in artifacts[].limitations.",
    );
    expect(extraction.limitations.length).toBeLessThan(10);
  },
);
