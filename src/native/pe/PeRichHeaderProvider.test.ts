import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectPeRichHeaderInputSchema } from "../../domain/native/peRichHeader.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { peRichHeaderImage } from "./PeRichHeader.fixture.js";
import { PeRichHeaderProvider } from "./PeRichHeaderProvider.js";

const inspect = async (path: string, max_entries?: number) => {
  const provider = new PeRichHeaderProvider();
  try {
    return await provider.inspect(
      inspectPeRichHeaderInputSchema.parse({
        path,
        ...(max_entries === undefined ? {} : { max_entries }),
      }),
    );
  } finally {
    await provider.close();
  }
};

describe("PE Rich header provider failures after a completed read", () => {
  it.each([
    ["an exhausted entry budget", peRichHeaderImage(), 2, "capacity"],
    ["a malformed PE header", Buffer.from("MZ not a PE image"), undefined, ""],
  ] as const)(
    "keeps the file identity on %s",
    async (_label, bytes, maxEntries, resource) => {
      const root = await createTestTempDirectory("rea-pe-rich-provider-");
      const path = join(root, "app.exe");
      await writeFile(path, bytes);
      const result = await inspect(path, maxEntries);
      if (result.ok) throw new Error("Expected a failure");
      if (resource !== "")
        expect(result.error).toMatchObject({
          _tag: "AnalysisResourceConstraintError",
          resource,
        });
      expect(result.error.partialObservation).toEqual({
        kind: "file-snapshot-hash",
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      });
    },
  );
});
