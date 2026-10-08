import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyRoot } from "../../../src/artifacts/inventory/classify.js";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("ZIP signature detection", () => {
  it.each([
    { signature: [0x50, 0x4b, 0x05, 0x06], archive: true },
    { signature: [0x50, 0x4b, 0x03, 0x06], archive: false },
    { signature: [0x50, 0x4b, 0x03, 0x04], archive: true },
    { signature: [0x50, 0x4b, 0x07, 0x08], archive: true },
  ] as const)(
    "routes representative ZIP signature $signature through inventory and target parsing",
    async ({ signature, archive }) => {
      const root = await createTestTempDirectory("rea-zip-signature-");
      const path = join(root, "input");
      await writeFile(path, Buffer.from(signature));
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
