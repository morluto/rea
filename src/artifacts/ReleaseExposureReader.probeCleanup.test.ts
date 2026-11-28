import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { asarHeaderBytes } from "../../tests/fixtures/asarHeader.js";
import { phaseGate } from "../../tests/support/lifecycleHarness.js";
import { pe } from "../domain/binaryTarget.fixture.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type { ReleaseExposureScan } from "../domain/releaseExposure.js";
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
  it("stops before reading CodeView when cancelled during probe-directory removal", async () => {
    const root = await createTestTempDirectory(
      "rea-release-exposure-probe-cancel-",
    );
    const image = Buffer.concat([
      pe(0x8664, 64, 0x0002, false, { pdbPath: "cancelled.pdb" }),
      Buffer.alloc(8192),
    ]);
    await writeFile(join(root, "app.asar"), asarWith("tool.dll", image));
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    const removal = phaseGate<string>();
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (String(path).includes("rea-release-member-"))
        await removal.hold(String(path));
      await actual.rm(path, options);
    });

    const reader = new ReleaseExposureReader();
    const controller = new AbortController();
    const reason = { phase: "release temporary PE probe" };
    const interrupted: ReleaseExposureScan[] = [];
    const pending = reader.inspect(
      { path: root },
      { signal: controller.signal },
      () => undefined,
      (scan) => interrupted.push(scan),
    );
    try {
      const directory = await removal.reached(
        pending,
        "PE probe directory removal",
      );
      await expect(access(directory)).resolves.toBeUndefined();
      controller.abort(reason);
      removal.release();
      const result = await pending;
      if (result.ok)
        throw new Error("Expected cancellation before CodeView inspection");
      expect(result.error).toBeInstanceOf(AnalysisCancelledError);
      expect(result.error.cause).toBe(reason);
      expect(interrupted).toMatchObject([
        { coverage: "unknown", pdb: { examined: 0, paths: [] } },
      ]);
      await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      removal.release();
      await pending;
      vi.mocked(rm).mockImplementation(actual.rm);
      await reader.close();
    }
  });
});
