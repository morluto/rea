import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import * as fileChunks from "../../filesystem/readFileHandleChunks.js";
import { SingleFileJavaScriptArtifactReader } from "./JavaScriptArtifactReader.js";

it("classifies incomplete single-file reads as read-coverage integrity failures", async () => {
  expect.assertions(2);
  const root = await createTestTempDirectory("rea-js-single-file-read-");
  const path = join(root, "entry.js");
  const source = "export const answer = 42;\n";
  await writeFile(path, source);
  const reader = new SingleFileJavaScriptArtifactReader(path);
  const readChunks = fileChunks.readFileHandleChunks;
  const observer = vi.spyOn(fileChunks, "readFileHandleChunks");
  try {
    for await (const entry of reader.entries()) {
      expect((await buffer(await reader.open(entry))).toString()).toBe(source);
      // Stop delivery early while the selected file's identity stays unchanged.
      observer.mockImplementationOnce((handle, options) =>
        readChunks(handle, { ...options, end: 0 }),
      );
      await expect(buffer(await reader.open(entry))).rejects.toMatchObject({
        reason: "integrity",
        integrityCheck: "read-coverage",
      });
    }
  } finally {
    observer.mockRestore();
    await reader.close();
  }
});
