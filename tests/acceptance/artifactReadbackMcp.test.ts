import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";
import { artifactExtractionResultSchema } from "../../src/domain/artifactGraph.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";

it.each(["full", "compact"] as const)(
  "preserves extraction bytes and provenance through the %s MCP output schema",
  async (profile) => {
    const root = await createTestTempDirectory("rea-artifact-readback-mcp-");
    const archive = join(root, "source.zip");
    const expected = new Map([
      ["empty", Buffer.alloc(0)],
      ["multi-chunk", Buffer.alloc(96 * 1024, 0x61)],
      ...Array.from({ length: 32 }, (_, index): [string, Buffer] => [
        `nested/file-${String(index)}`,
        Buffer.alloc(16 * 1024, index),
      ]),
    ]);
    const writer = new ZipWriter(new Uint8ArrayWriter());
    for (const [path, bytes] of expected)
      await writer.add(path, new Uint8ArrayReader(bytes));
    const source = Buffer.from(await writer.close());
    await writeFile(archive, source);
    const { call } = await connectLocalToolsMcp({
      REA_MCP_OUTPUT_SCHEMA_PROFILE: profile,
      TEMP: root,
      TMP: root,
    });
    expect((await call("open_binary", { path: archive })).isError).not.toBe(
      true,
    );
    const response = await call("extract_artifact", {});
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = parseEvidence(response.structuredContent);
    const result = artifactExtractionResultSchema.parse(
      evidence.normalized_result,
    );
    expect(evidence.subject?.digest.sha256).toBe(
      createHash("sha256").update(source).digest("hex"),
    );
    expect(result.artifacts).toHaveLength(expected.size);
    expect(dirname(result.output_root)).toBe(root);
    expect(result.containment_verified).toBe(true);
    for (const artifact of result.artifacts) {
      const original = expected.get(artifact.relative_path);
      if (original === undefined)
        throw new Error("Unexpected extracted member");
      expect(artifact.sha256).toBe(
        createHash("sha256").update(original).digest("hex"),
      );
      expect(artifact.bytes_written).toBe(original.length);
      expect(
        (
          await readFile(join(result.output_root, artifact.relative_path))
        ).equals(original),
      ).toBe(true);
    }
    expect((await readFile(archive)).equals(source)).toBe(true);
    expect((await call("close_binary", {})).isError).not.toBe(true);
  },
);
