import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { withRetainedContent } from "./DesktopRetainedContent.js";

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

describe("RetainedContent", () => {
  it("says whether retained content is too large, missing or altered", async () => {
    const folder = await createTestTempDirectory("desktop-retained-");
    await mkdir(join(folder, "content"));
    const large = "x".repeat(1024 * 1024 + 1);
    await writeFile(join(folder, "content", digest("kept")), "kept");
    await writeFile(join(folder, "content", digest(large)), large);
    await writeFile(join(folder, "content", digest("altered")), "kept");

    const reads = await withRetainedContent(
      folder,
      async (content) => [
        await content.read(digest("kept")),
        await content.read(digest(large)),
        await content.read(digest("missing")),
        await content.read(digest("altered")),
      ],
      1024 * 1024,
    );

    expect(
      reads.map((read) => (read.ok ? read.value.toString("utf8") : read.error)),
    ).toEqual([
      "kept",
      "is larger than the 1 MiB read limit",
      "is missing or unreadable",
      "does not match its digest",
    ]);
  });
});
