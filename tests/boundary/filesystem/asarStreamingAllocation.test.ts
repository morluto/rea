import { createHash } from "node:crypto";
import { mkdir, writeFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import { createPackageWithOptions } from "@electron/asar";
import { describe, expect, it } from "vitest";
import { AsarArtifactReader } from "../../../src/artifacts/AsarArtifactReader.js";
import { hashReadable } from "../../../src/artifacts/ArtifactHash.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const memberBytes = 64 * 1024 * 1024;
const expectedSha256 = (): string => {
  const hash = createHash("sha256");
  const zeros = Buffer.alloc(64 * 1024);
  for (let written = 0; written < memberBytes; written += zeros.length)
    hash.update(zeros);
  return hash.digest("hex");
};

describe("ASAR entry streaming", () => {
  it.each([
    ["packed", {}],
    ["unpacked", { unpack: "large.bin" }],
  ] as const)(
    "opens a %s member without allocating its full contents",
    async (_kind, options) => {
      const root = await createTestTempDirectory("rea-asar-streaming-");
      const source = join(root, "source");
      const archive = join(root, "fixture.asar");
      const member = join(source, "large.bin");
      await mkdir(source);
      await writeFile(member, Buffer.alloc(0));
      await truncate(member, memberBytes);
      await createPackageWithOptions(source, archive, options);

      const reader = new AsarArtifactReader(archive);
      try {
        const entries = [];
        for await (const entry of reader.entries()) entries.push(entry);
        const entry = entries.find(({ path }) => path === "large.bin");
        if (entry === undefined) throw new Error("Expected large ASAR member");

        const before = process.memoryUsage().arrayBuffers;
        const stream = await reader.open(entry);
        const afterOpen = process.memoryUsage().arrayBuffers;
        const observed = await hashReadable(stream);
        const allocation = afterOpen - before;

        expect(allocation).toBeLessThan(memberBytes / 2);
        expect(observed).toMatchObject({
          sha256: expectedSha256(),
          bytes: memberBytes,
        });
      } finally {
        await reader.close();
      }
    },
    120_000,
  );
});
