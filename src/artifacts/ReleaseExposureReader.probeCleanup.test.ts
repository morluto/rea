import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { asarHeaderBytes } from "../../tests/fixtures/asarHeader.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { nodeSeaElf } from "./nodeSea/NodeSea.fixture.js";
import { ReleaseExposureReader } from "./ReleaseExposureReader.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const asarWith = (name: string, bytes: Buffer): Buffer =>
  Buffer.concat([
    asarHeaderBytes(
      JSON.stringify({
        files: { [name]: { size: bytes.length, offset: "0" } },
      }),
    ),
    bytes,
  ]);

describe("ReleaseExposureReader probe directory cleanup", () => {
  it("reports a failed removal and retries it on close", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-probe-");
    await writeFile(
      join(root, "app.asar"),
      asarWith("tool.node", nodeSeaElf()),
    );
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    const removed: string[] = [];
    vi.mocked(rm).mockImplementation(async (path, options) => {
      const target = String(path);
      if (target.includes("rea-release-member-") && removed.length === 0) {
        removed.push(target);
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      }
      await actual.rm(path, options);
    });

    const reader = new ReleaseExposureReader();
    try {
      const result = await reader.inspect(
        { path: root },
        undefined,
        () => undefined,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const [directory] = removed;
      if (directory === undefined) throw new Error("No probe directory.");
      expect(result.error).toMatchObject({
        cleanup: { resources: expect.arrayContaining([directory]) },
      });
      await expect(access(directory)).resolves.toBeUndefined();
      await reader.close();
      await expect(access(directory)).rejects.toThrow();
    } finally {
      vi.mocked(rm).mockImplementation(actual.rm);
      await reader.close();
    }
  });
});
