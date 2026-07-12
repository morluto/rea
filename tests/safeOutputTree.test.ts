import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir } from "node:fs/promises";
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

describe("safe artifact output tree", () => {
  it("removes only its owned tree after digest failure and proves absence", async () => {
    const parent = await mkdtemp(join(tmpdir(), "rea-safe-output-"));
    const output = join(parent, "published");
    const tree = await SafeOutputTree.create(output, LIMITS);
    await expect(
      tree.write(
        "nested/file.txt",
        Readable.from(Buffer.from("unexpected")),
        "0".repeat(64),
      ),
    ).rejects.toThrow(/disagrees/u);
    expect(await tree.rollback()).toMatchObject({
      attempted: true,
      verified: true,
      residualPaths: [],
    });
    await expect(access(output)).rejects.toThrow();
    expect(await readdir(parent)).toEqual([]);
  });

  it("publishes files while building and preserves them after sealing", async () => {
    const parent = await mkdtemp(join(tmpdir(), "rea-safe-output-"));
    const output = join(parent, "published");
    const tree = await SafeOutputTree.create(output, LIMITS);
    const bytes = Buffer.from("visible before seal");
    const digest = createHash("sha256").update(bytes).digest("hex");

    await tree.write("file.txt", Readable.from(bytes), digest);
    expect(await readFile(join(output, "file.txt"), "utf8")).toBe(
      "visible before seal",
    );

    await tree.commit();
    expect(await tree.rollback()).toMatchObject({ attempted: false });
    expect(await readFile(join(output, "file.txt"), "utf8")).toBe(
      "visible before seal",
    );
  });
});
