import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { inspectPeRichHeaderInputSchema } from "../../domain/native/peRichHeader.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { peRichHeaderImage } from "./PeRichHeader.fixture.js";
import * as parser from "./PeRichHeaderParser.js";
import { PeRichHeaderProvider } from "./PeRichHeaderProvider.js";

const inspect = async (
  path: string,
  max_entries?: number,
  signal?: AbortSignal,
) => {
  const provider = new PeRichHeaderProvider();
  try {
    return await provider.inspect(
      inspectPeRichHeaderInputSchema.parse({
        path,
        ...(max_entries === undefined ? {} : { max_entries }),
      }),
      signal === undefined ? undefined : { signal },
    );
  } finally {
    await provider.close();
  }
};

const fileIdentity = (path: string, bytes: Buffer) => ({
  kind: "file-snapshot-hash",
  path,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
});

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
      expect(result.error.partialObservation).toEqual(
        fileIdentity(path, bytes),
      );
    },
  );

  it("keeps the file identity when cancellation arrives during decoding", async () => {
    const root = await createTestTempDirectory("rea-pe-rich-provider-");
    const path = join(root, "app.exe");
    // A 4 MiB stub makes the checksum yield, so the abort lands mid-decode.
    const bytes = peRichHeaderImage({ stub: Buffer.alloc(0x400000, 0x90) });
    await writeFile(path, bytes);
    const controller = new AbortController();
    const reason = new Error("cancel while decoding the Rich header");
    const decode = parser.parsePeRichHeader;
    const spy = vi
      .spyOn(parser, "parsePeRichHeader")
      .mockImplementationOnce((...arguments_) => {
        const pending = decode(...arguments_);
        controller.abort(reason);
        return pending;
      });
    try {
      const result = await inspect(path, undefined, controller.signal);
      if (result.ok) throw new Error("Expected cancellation");
      expect(spy).toHaveBeenCalledOnce();
      expect(result.error).toMatchObject({
        _tag: "AnalysisCancelledError",
        cause: reason,
      });
      expect(result.error.partialObservation).toEqual(
        fileIdentity(path, bytes),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
