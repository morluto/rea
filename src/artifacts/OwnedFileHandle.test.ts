import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { phaseGate } from "../../tests/support/lifecycleHarness.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";

it.each(["confirmed", "unconfirmed"] as const)(
  "shares a %s descriptor close across callers and subsequent attempts",
  async (outcome) => {
    const path = join(
      await createTestTempDirectory("rea-owned-close-"),
      "input",
    );
    await writeFile(path, "owned file");
    const descriptor = await open(path);
    const nativeClose = descriptor.close.bind(descriptor);
    const held = phaseGate();
    const refusal = new Error("native close failed after invalidation");
    const physicalClose = vi
      .spyOn(descriptor, "close")
      .mockImplementation(async () => {
        await held.hold();
        await nativeClose();
        if (outcome === "unconfirmed") throw refusal;
      });
    const owner = new OwnedFileHandle(descriptor);
    const first = owner.close();
    let concurrent: Promise<void> | undefined;

    try {
      await held.reached(first, "physical descriptor close");
      concurrent = owner.close();
      const callers = Promise.allSettled([first, concurrent]);
      held.release();
      const initial = await callers;
      const later = await Promise.allSettled([owner.close()]);
      for (const result of [...initial, ...later]) {
        expect(result.status).toBe(
          outcome === "confirmed" ? "fulfilled" : "rejected",
        );
        if (result.status === "rejected") expect(result.reason).toBe(refusal);
      }
      expect(descriptor.fd).toBe(-1);
      expect(physicalClose).toHaveBeenCalledTimes(1);
    } finally {
      held.release();
      await Promise.allSettled([first, concurrent]);
      if (descriptor.fd >= 0) await nativeClose();
    }
  },
);
