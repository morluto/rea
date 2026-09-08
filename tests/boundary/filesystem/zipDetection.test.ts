import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyRoot } from "../../../src/application/ArtifactInventory/classify.js";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("ZIP signature detection", () => {
  it.each([
    [0x03, 0x04, true],
    [0x05, 0x06, true],
    [0x07, 0x08, true],
    [0x03, 0x06, false],
    [0x03, 0x08, false],
    [0x05, 0x04, false],
    [0x05, 0x08, false],
    [0x07, 0x04, false],
    [0x07, 0x06, false],
  ] as const)(
    "classifies PK %i %i with archive signature %s",
    async (third, fourth, archive) => {
      const root = await createTestTempDirectory("rea-zip-signature-");
      const path = join(root, "input");
      await writeFile(path, Buffer.from([0x50, 0x4b, third, fourth]));
      expect(await classifyRoot(path, false)).toBe(archive ? "zip" : "file");
      const target = await parseBinaryTarget(path);
      if (archive)
        expect(target).toMatchObject({ ok: true, value: { format: "zip" } });
      else
        expect(target).toMatchObject({
          ok: false,
          error: { _tag: "BinaryTargetError" },
        });
    },
  );

  it.each([[], [0x50], [0x50, 0x4b], [0x50, 0x4b, 0x03]])(
    "rejects an incomplete signature %j",
    async (...bytes) => {
      const root = await createTestTempDirectory("rea-zip-short-");
      const path = join(root, "input");
      await writeFile(path, Buffer.from(bytes));
      expect(await classifyRoot(path, false)).toBe("file");
      expect((await parseBinaryTarget(path)).ok).toBe(false);
    },
  );
});
