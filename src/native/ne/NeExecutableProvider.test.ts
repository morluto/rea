import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { inspectNeExecutableInputSchema } from "../../domain/native/neExecutable.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { neFixture } from "./NeExecutable.fixture.js";
import { NeExecutableProvider } from "./NeExecutableProvider.js";

const parsing = vi.hoisted(() => ({ controller: new AbortController() }));

vi.mock("./NeExecutableParser.js", async (original) => {
  const parser = await original<typeof import("./NeExecutableParser.js")>();
  return {
    ...parser,
    parseNeExecutable: (
      ...args: Parameters<typeof parser.parseNeExecutable>
    ) => {
      // Cancel exactly between the completed read and NE decoding.
      parsing.controller.abort();
      return parser.parseNeExecutable(...args);
    },
  };
});

it("retains the verified file identity when cancelled after the read", async () => {
  const root = await createTestTempDirectory("rea-ne-cancel-");
  const path = join(root, "sample.dll");
  const { bytes } = neFixture();
  await writeFile(path, bytes);
  const provider = new NeExecutableProvider();
  try {
    const result = await provider.inspect(
      inspectNeExecutableInputSchema.parse({ path }),
      { signal: parsing.controller.signal },
    );
    if (result.ok) throw new Error("Expected cancellation");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(result.error).toMatchObject({
      _tag: "AnalysisCancelledError",
      partialObservation: {
        kind: "file-snapshot-hash",
        path,
        sha256,
        bytes: bytes.length,
      },
    });
  } finally {
    await provider.close();
  }
});
