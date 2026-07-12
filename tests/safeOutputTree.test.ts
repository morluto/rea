import { access, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { SafeOutputTree } from "../src/artifacts/SafeOutputTree.js";

const LIMITS = {
  maxEntries: 10,
  maxTotalBytes: 1_024,
  maxEntryBytes: 512,
  maxCompressionRatio: 10,
  maxDepth: 8,
  maxPathBytes: 256,
} as const;

describe("safe artifact output transaction", () => {
  it("removes only its owned tree after digest failure and proves absence", async () => {
    const parent = await mkdtemp(join(tmpdir(), "rea-safe-output-"));
    const output = join(parent, "published");
    const transaction = await SafeOutputTree.create(output, LIMITS);
    await expect(
      transaction.write(
        "nested/file.txt",
        Readable.from(Buffer.from("unexpected")),
        "0".repeat(64),
      ),
    ).rejects.toThrow(/disagrees/u);
    expect(await transaction.rollback()).toMatchObject({
      attempted: true,
      verified: true,
      residualPaths: [],
    });
    await expect(access(output)).rejects.toThrow();
    expect(await readdir(parent)).toEqual([]);
  });
});
