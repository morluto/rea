import { open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  phaseGate,
  settledCause,
} from "../../tests/support/lifecycleHarness.js";
import { ArtifactFileSource } from "./ArtifactFileSource.js";

it.each(["closed", "close refused"] as const)(
  "handles cancelled source admission with its descriptor %s",
  async (outcome) => {
    const path = join(
      await createTestTempDirectory("rea-source-admission-"),
      "input",
    );
    await writeFile(path, "source");
    const source = new ArtifactFileSource(path, "fixture");
    const controller = new AbortController();
    const reason = { stop: "admission" };
    const observed = await open(path, "r");
    const prototype = Object.getPrototypeOf(observed) as FileHandle;
    await observed.close();
    const stat = prototype.stat;
    const closeFailure = new Error("close denied");
    let admitted: FileHandle | undefined;
    const spy = vi
      .spyOn(prototype, "stat")
      .mockImplementationOnce(async function (
        this: FileHandle,
        ...args: Parameters<typeof stat>
      ) {
        const result = await stat.apply(this, args);
        admitted = this;
        if (outcome === "close refused")
          vi.spyOn(this, "close").mockRejectedValueOnce(closeFailure);
        controller.abort(reason);
        return result;
      });
    try {
      const failure = await settledCause(source.read(controller.signal));
      expect(failure).toMatchObject({
        reason: "cancelled",
        cancellation: { reason },
      });
      if (admitted === undefined)
        throw new Error("Expected the admitted descriptor");
      if (outcome === "close refused") {
        expect(failure).toMatchObject({
          cleanup: { reason: closeFailure.message, resources: [path] },
        });
        await expect(source.read()).rejects.toBe(failure);
        expect(admitted.fd).toBeGreaterThanOrEqual(0);
        await source.close();
        expect(admitted.fd).toBe(-1);
      } else {
        expect(admitted.fd).toBe(-1);
        const retry = await source.read();
        expect(retry.handle).not.toBe(admitted);
        expect(retry.initial.size).toBe(6);
      }
    } finally {
      spy.mockRestore();
      try {
        await source.close();
      } finally {
        if (admitted !== undefined && admitted.fd >= 0) await admitted.close();
      }
    }
  },
);

it("lets another caller continue when shared admission is cancelled", async () => {
  const path = join(
    await createTestTempDirectory("rea-artifact-source-shared-"),
    "input",
  );
  await writeFile(path, "source");
  const source = new ArtifactFileSource(path, "fixture");
  const controller = new AbortController();
  const reason = { stop: "first admission" };
  const observed = await open(path, "r");
  const prototype = Object.getPrototypeOf(observed) as FileHandle;
  await observed.close();
  const stat = prototype.stat;
  const admission = phaseGate();
  let firstDescriptor: FileHandle | undefined;
  const spy = vi.spyOn(prototype, "stat").mockImplementation(async function (
    this: FileHandle,
    ...args: Parameters<typeof stat>
  ) {
    const result = await stat.apply(this, args);
    if (firstDescriptor === undefined) {
      firstDescriptor = this;
      await admission.hold();
    }
    return result;
  });
  const first = source.read(controller.signal);
  const inFlight = [first];
  try {
    await admission.reached(first, "artifact source admission");
    const second = source.read();
    inFlight.push(second);
    const results = Promise.allSettled([first, second]);
    await Promise.resolve();
    controller.abort(reason);
    admission.release();
    const [cancelled, retry] = await results;
    expect(cancelled).toMatchObject({
      status: "rejected",
      reason: { reason: "cancelled", cause: reason },
    });
    if (retry.status === "rejected") throw retry.reason;
    expect(firstDescriptor?.fd).toBe(-1);
    expect(retry.value.handle).not.toBe(firstDescriptor);
    expect(retry.value.initial.size).toBe(6);
  } finally {
    admission.release();
    await Promise.allSettled(inFlight);
    spy.mockRestore();
    try {
      await source.close();
    } finally {
      if (firstDescriptor !== undefined && firstDescriptor.fd >= 0)
        await firstDescriptor.close();
    }
  }
});
