import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { scanArtifactInventory } from "../src/application/ArtifactInventory.js";
import {
  scanVersionInventories,
  type VersionInventoryScanner,
} from "../src/application/CrossVersionInventory.js";

const LIMITS = {
  maxEntries: 10,
  maxTotalBytes: 1_024,
  maxEntryBytes: 512,
  maxCompressionRatio: 10,
  maxDepth: 8,
  maxPathBytes: 256,
} as const;

const INTEGRITY = {
  mode: "fail",
  approved: false,
  enabled: false,
  maxMismatches: 1,
} as const;

const deferred = <Value>() => {
  let resolvePromise: (value: Value) => void = () => undefined;
  let rejectPromise: (reason: unknown) => void = () => undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

describe("cross-version inventory", () => {
  it("starts both scans together and preserves left/right result order", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-version-inventory-"));
    try {
      const artifact = join(root, "artifact.js");
      await writeFile(artifact, "export const value = 1;\n");
      const snapshot = await scanArtifactInventory(artifact, LIMITS);
      const left = deferred<typeof snapshot>();
      const right = deferred<typeof snapshot>();
      const calls: string[] = [];
      const controller = new AbortController();
      const scanner: VersionInventoryScanner = (...arguments_) => {
        const [path, roots, limits, signal, integrity] = arguments_;
        calls.push(path);
        expect(roots).toEqual([root]);
        expect(limits).toBe(LIMITS);
        expect(signal).toBe(controller.signal);
        expect(integrity).toBe(INTEGRITY);
        return path === "left" ? left.promise : right.promise;
      };

      const result = scanVersionInventories(
        {
          leftPath: "left",
          rightPath: "right",
          inputRoots: [root],
          limits: LIMITS,
          signal: controller.signal,
          integrity: INTEGRITY,
        },
        scanner,
      );

      expect(calls).toEqual(["left", "right"]);
      right.resolve(snapshot);
      left.resolve(snapshot);
      await expect(result).resolves.toEqual({
        left: snapshot,
        right: snapshot,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects promptly when either parallel scan fails", async () => {
    const left = deferred<never>();
    const failure = new Error("right scan failed");
    const scanner: VersionInventoryScanner = (path) =>
      path === "left" ? left.promise : Promise.reject(failure);

    await expect(
      scanVersionInventories(
        {
          leftPath: "left",
          rightPath: "right",
          inputRoots: ["/approved"],
          limits: LIMITS,
          integrity: INTEGRITY,
        },
        scanner,
      ),
    ).rejects.toBe(failure);
  });
});
