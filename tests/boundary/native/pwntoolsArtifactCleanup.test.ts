import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";

const closeState = vi.hoisted(() => ({
  fail: false,
  failOnce: false,
  opened: 0,
  closes: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      closeState.opened++;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closeState.closes++;
        if (closeState.fail || closeState.failOnce) {
          closeState.failOnce = false;
          throw new Error("injected stable artifact close failure");
        }
        return close();
      };
      return handle;
    },
  };
});

import { PwntoolsDecoder } from "../../../src/native/pwntools/PwntoolsDecoder.js";
import { PWNTOOLS_PROVIDER_IDENTITY } from "../../../src/native/pwntools/PwntoolsRelease.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";

const makeDecoder = () =>
  new PwntoolsDecoder(
    {
      identity: PWNTOOLS_PROVIDER_IDENTITY,
      operation: "test_pwntools_artifact_read",
      bridge: new URL("file:///unused-bridge.py"),
      payloadSchema: z.string(),
      project: () => {
        throw new Error("input read should fail before decoder launch");
      },
    },
    { REA_PWNTOOLS_PYTHON: process.execPath },
    undefined,
    async () => {
      throw new Error("runtime should not be created for failed input read");
    },
  );

const emulateSupportedHost = async (
  run: () => Promise<void>,
): Promise<void> => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const arch = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  Object.defineProperty(process, "arch", { ...arch, value: "x64" });
  try {
    await run();
  } finally {
    if (platform !== undefined)
      Object.defineProperty(process, "platform", platform);
    if (arch !== undefined) Object.defineProperty(process, "arch", arch);
  }
};

it("reports the read failure without stale incomplete-cleanup state when close retry succeeds", async () =>
  emulateSupportedHost(async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-pwntools-close-retry-"));
    const path = join(root, "selected.bin");
    await writeFile(path, "selected evidence");
    closeState.fail = false;
    closeState.failOnce = true;
    closeState.opened = 0;
    closeState.closes = 0;
    const decoder = makeDecoder();
    try {
      const result = await decoder.inspect({ path });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Injected close failure was not returned");
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(projectAnalysisError(result.error).code).not.toBe(
        "cleanup_incomplete",
      );
      expect(result.error.cause).toMatchObject({
        cleanup: {
          resources: [path],
          reason: expect.stringContaining(
            "injected stable artifact close failure",
          ),
        },
      });
      expect(closeState.closes).toBeGreaterThanOrEqual(2);
    } finally {
      closeState.fail = false;
      closeState.failOnce = false;
      await decoder.close();
      await rm(root, { recursive: true, force: true });
    }
  }));

it("retains a persistent failed input descriptor and refuses the next acquisition", async () =>
  emulateSupportedHost(async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-pwntools-held-close-"));
    const path = join(root, "selected.bin");
    await writeFile(path, "selected evidence");
    closeState.fail = true;
    closeState.failOnce = false;
    closeState.opened = 0;
    closeState.closes = 0;
    const decoder = makeDecoder();
    try {
      const first = await decoder.inspect({ path });
      expect(first.ok).toBe(false);
      if (first.ok)
        throw new Error("Persistent close failure was not returned");
      expect(projectAnalysisError(first.error).code).toBe("cleanup_incomplete");
      const openedAfterFailure = closeState.opened;

      const retry = await decoder.inspect({ path });
      expect(retry.ok).toBe(false);
      if (retry.ok) throw new Error("Retained descriptor was not retried");
      expect(projectAnalysisError(retry.error).code).toBe("cleanup_incomplete");
      expect(closeState.opened).toBe(openedAfterFailure);

      await expect(decoder.close()).rejects.toMatchObject({
        cleanupIncomplete: true,
      });
      closeState.fail = false;
      await decoder.close();
    } finally {
      closeState.fail = false;
      closeState.failOnce = false;
      try {
        await decoder.close();
      } catch {
        // The test already asserts persistent cleanup failure before releasing it.
      }
      await rm(root, { recursive: true, force: true });
    }
  }));
