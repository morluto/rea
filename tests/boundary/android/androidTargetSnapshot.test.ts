import { createHash } from "node:crypto";
import { stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { snapshotAndroidTarget } from "../../../src/android/AndroidTargetSnapshot.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import {
  RegularFileCleanupFailure,
  regularFileCancellation,
} from "../../../src/filesystem/OwnedRegularFile.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each(["close-failure", "final-cancellation", "retention-throws"] as const)(
  "retains the exact failed snapshot owner for retry: %s",
  async (scenario) => {
    const root = await createTestTempDirectory("rea-android-snapshot-close-");
    const source = join(root, "source.apk");
    const bytes = Buffer.from("selected APK bytes");
    await writeFile(source, bytes);
    const controller = new AbortController();
    const reason = new Error("cancelled during final close");
    const closeFailure = new Error("snapshot descriptor close denied");
    const retentionFailure = new Error("retention callback failed");
    const retained = new Map<OwnedFileHandle, string>();
    const originalClose = OwnedFileHandle.prototype.close;
    let failedOwner: OwnedFileHandle | undefined;
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(function (this: OwnedFileHandle) {
        if (failedOwner === undefined) {
          failedOwner = this;
          if (scenario === "final-cancellation") controller.abort(reason);
        }
        if (this === failedOwner) return Promise.reject(closeFailure);
        return originalClose.call(this);
      });
    try {
      const failure = await snapshotAndroidTarget(
        source,
        createHash("sha256").update(bytes).digest("hex"),
        root,
        "inspect_android_package",
        controller.signal,
        (path, owner) => {
          retained.set(owner, path);
          if (scenario === "retention-throws") throw retentionFailure;
        },
      ).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
      if (!(failure instanceof RegularFileCleanupFailure))
        throw new Error("Expected a failed snapshot descriptor close");
      expect(failure.cleanupCause).toBe(closeFailure);
      expect(failure.owner).toBe(failedOwner);
      expect(failure.retention).toEqual(
        scenario === "retention-throws"
          ? { kind: "callback_threw", cause: retentionFailure }
          : { kind: "callback_returned" },
      );
      expect(retained.get(failure.owner)).toBe(failure.path);
      if (scenario === "final-cancellation")
        expect(regularFileCancellation(failure)?.reason).toBe(reason);
      else expect(regularFileCancellation(failure)).toBeUndefined();
      expect(failure.owner.handle.fd).toBeGreaterThanOrEqual(0);
      close.mockRestore();
      await failure.owner.close();
      expect(failure.owner.handle.fd).toBe(-1);
    } finally {
      close.mockRestore();
      await Promise.all([...retained.keys()].map((owner) => owner.close()));
    }
  },
);

it("retains both snapshot owners when the copy fails and both closes fail", async () => {
  const root = await createTestTempDirectory(
    "rea-android-snapshot-mixed-close-",
  );
  const source = join(root, "source.apk");
  const snapshot = join(root, "target.apk");
  await writeFile(source, "selected APK bytes");
  const retained = new Map<OwnedFileHandle, string>();
  const attempted = new Set<OwnedFileHandle>();
  const closeFailure = new Error("snapshot descriptor close denied");
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(function (this: OwnedFileHandle) {
      attempted.add(this);
      return Promise.reject(closeFailure);
    });
  try {
    const failure = await snapshotAndroidTarget(
      source,
      "0".repeat(64),
      root,
      "inspect_android_package",
      undefined,
      (path, owner) => retained.set(owner, path),
    ).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
    if (!(failure instanceof RegularFileCleanupFailure))
      throw new Error("Expected source cleanup failure");
    expect(failure.path).toBe(source);
    expect(failure.cleanupCause).toBe(closeFailure);
    expect(failure.retention).toEqual({ kind: "callback_returned" });
    expect(failure.outcome.kind).toBe("failed");
    if (failure.outcome.kind !== "failed")
      throw new Error("Expected nested failure");
    const destinationFailure = failure.outcome.cause;
    expect(destinationFailure).toBeInstanceOf(RegularFileCleanupFailure);
    if (!(destinationFailure instanceof RegularFileCleanupFailure))
      throw new Error("Expected destination cleanup failure");
    expect(destinationFailure.path).toBe(snapshot);
    expect(destinationFailure.cleanupCause).toBe(closeFailure);
    expect(destinationFailure.retention).toEqual({ kind: "callback_returned" });
    expect(destinationFailure.outcome).toMatchObject({
      kind: "failed",
      cause: {
        _tag: "AnalysisInputError",
        issues: [
          {
            path: ["path"],
            reason: "invalid_value",
            message: expect.stringContaining(
              `APK bytes changed after admission at ${source}`,
            ),
          },
        ],
      },
    });
    expect(retained.size).toBe(2);
    expect(retained.get(failure.owner)).toBe(source);
    expect(retained.get(destinationFailure.owner)).toBe(snapshot);
    expect(failure.owner).not.toBe(destinationFailure.owner);
    expect([...retained.keys()].every((owner) => owner.handle.fd >= 0)).toBe(
      true,
    );

    close.mockRestore();
    await failure.owner.close();
    expect(failure.owner.handle.fd).toBe(-1);
    expect(destinationFailure.owner.handle.fd).toBeGreaterThanOrEqual(0);
    expect(retained.get(destinationFailure.owner)).toBe(snapshot);
    await destinationFailure.owner.close();
    expect([...retained.keys()].every((owner) => owner.handle.fd === -1)).toBe(
      true,
    );
  } finally {
    close.mockRestore();
    await Promise.all([...attempted].map((owner) => owner.close()));
  }
});

it.skipIf(process.platform === "win32")(
  "cancels an in-flight APK snapshot and removes its partial output",
  async () => {
    const root = await createTestTempDirectory("rea-android-snapshot-cancel-");
    const source = join(root, "large.apk");
    const snapshot = join(root, "target.apk");
    await writeFile(source, "");
    // A sparse extent keeps fixture setup cheap while ensuring the copy cannot
    // finish before the test observes its first output bytes and aborts it.
    await truncate(source, 64 * 1024 * 1024 * 1024);

    const controller = new AbortController();
    const retained = new Set<OwnedFileHandle>();
    const pending = snapshotAndroidTarget(
      source,
      "0".repeat(64),
      root,
      "inspect_android_package",
      controller.signal,
      (_path, owner) => retained.add(owner),
    );
    try {
      await expect
        .poll(
          () =>
            stat(snapshot).then(
              ({ size }) => size > 0,
              () => false,
            ),
          { interval: 10 },
        )
        .toBe(true);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await expect(stat(snapshot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      controller.abort();
      await pending.catch(() => undefined);
      await Promise.all([...retained].map((owner) => owner.close()));
    }
  },
);
