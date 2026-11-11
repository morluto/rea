import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { AnalysisCleanupLease } from "../../artifacts/AnalysisCleanupLease.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import type { Evidence } from "../../domain/evidence.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { DesktopSessionCleanupError } from "../../desktop/DesktopApplicationSession.js";
import { DesktopContentStore } from "../../desktop/DesktopContentStore.js";
import { walkHomeState } from "../../desktop/HomeStateWalker.js";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import { captureDesktopApplication } from "./DesktopApplicationCapture.js";
import { CaptureFile } from "./DesktopCaptureOutput.js";
import {
  discardFailedCapture,
  failedCaptureError,
  projectFailure,
  publishedCaptureCleanup,
} from "./DesktopCaptureFailure.js";

const PROCESS_REASON = "token-owned process remained after cleanup";
const PROCESS_RESOURCES = ["run-1", "pid:10", "process-group:10"];
const HANDLE_REASON =
  "a retained file's handle could not be closed after a retry";

/** Processes whose release fails `failures` times before it succeeds. */
const unreleasedProcesses = (failures: number) => {
  let attempts = 0;
  const lease = new AnalysisCleanupLease(async () => {
    attempts += 1;
    if (attempts <= failures) throw new Error("still running");
  }, PROCESS_RESOURCES);
  return { reason: PROCESS_REASON, leases: [lease] };
};

/**
 * A store that retained one file whose handle close failed during the read;
 * the close fails `closeFailures` times in all before it succeeds.
 */
const storeWithFailedClose = async (closeFailures: number) => {
  const root = await createTestTempDirectory("desktop-failure-");
  const path = join(root, "files/state.ini");
  await mkdir(join(root, "files"));
  await mkdir(join(root, "capture"));
  await writeFile(path, "count=0\n");
  const { entries } = await walkHomeState([join(root, "files")], [], 100);
  const store = new DesktopContentStore(join(root, "capture"), 1024, 1024);
  await store.prepare();
  const close = vi.spyOn(OwnedFileHandle.prototype, "close");
  for (let failure = 0; failure < closeFailures; failure += 1)
    close.mockRejectedValueOnce(new Error("close denied"));
  const state = entries.get(path);
  if (state === undefined) throw new Error("state.ini was not walked");
  expect(await store.retain(path, state)).toEqual({
    kind: "omitted",
    reason: "unreadable",
  });
  return { root, path, store };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("publishedCaptureCleanup", () => {
  it.each([
    { processes: "released", closeFailures: 1, incomplete: [] },
    { processes: "released", closeFailures: 2, incomplete: ["handles"] },
    { processes: "unreleased", closeFailures: 1, incomplete: ["processes"] },
    {
      processes: "unreleased",
      closeFailures: 2,
      incomplete: ["processes", "handles"],
    },
  ])(
    "reports only what stays owned: processes $processes, handle close failing $closeFailures times",
    async ({ processes, closeFailures, incomplete }) => {
      const { path, store } = await storeWithFailedClose(closeFailures);

      const error = await publishedCaptureCleanup(
        "/out/capture.json",
        store,
        processes === "released" ? undefined : unreleasedProcesses(0),
      );

      const expected = {
        processes: { reason: PROCESS_REASON, resources: PROCESS_RESOURCES },
        handles: { reason: HANDLE_REASON, resources: [path] },
      };
      const left = incomplete.map(
        (owner) => expected[owner as keyof typeof expected],
      );
      expect(error?.cleanup).toEqual(
        left.length === 0
          ? undefined
          : {
              reason: left.map((entry) => entry.reason).join("; "),
              resources: left.flatMap((entry) => entry.resources),
            },
      );
      expect(error?.userMessage).toEqual(
        left.length === 0
          ? undefined
          : expect.stringContaining("The capture was written to"),
      );
      await store.close();
    },
  );

  it("keeps the error incomplete until every retained owner releases", async () => {
    const { path, store } = await storeWithFailedClose(2);
    const processes = unreleasedProcesses(1);

    const error = await publishedCaptureCleanup(
      "/out/capture.json",
      store,
      processes,
    );

    expect(error?.cleanupResources).toEqual([...PROCESS_RESOURCES, path]);
    await store.close();
    expect(error?.cleanupIncomplete).toBe(true);
    expect(error?.cleanupResources).toEqual(PROCESS_RESOURCES);
    await expect(processes.leases[0]?.release()).rejects.toThrow(
      "still running",
    );
    expect(error?.cleanupIncomplete).toBe(true);
    await processes.leases[0]?.release();
    expect(error?.cleanupIncomplete).toBe(false);
    expect(error?.cleanupResources).toEqual([]);
  });
});

describe("discardFailedCapture", () => {
  it("keeps each owner whose removal or close failed and releases it on retry", async () => {
    const { root, path, store } = await storeWithFailedClose(2);
    const foreign = join(store.directory, "foreign");
    await writeFile(foreign, "kept");
    const captureFile = new CaptureFile(join(root, "capture"));

    const discarded = await discardFailedCapture(store, captureFile);
    const error = failedCaptureError(
      new Error("walk failed"),
      discarded,
    ) as ProviderAdapterError;

    expect(error.cleanup).toEqual({
      reason: `the content the failed capture retained could not be removed; ${HANDLE_REASON}`,
      resources: [store.directory, path],
    });
    await rm(foreign);
    await discarded[0]?.leases[0]?.release();
    expect(error.cleanupResources).toEqual([path]);
    await store.close();
    expect(error.cleanupIncomplete).toBe(false);
    expect(await readdir(join(root, "capture"))).toEqual([]);
  });

  it("reports the unpublished capture file's handle until its close succeeds", async () => {
    const root = await createTestTempDirectory("desktop-failure-publish-");
    const store = new DesktopContentStore(root, 1024, 1024);
    await store.prepare();
    const captureFile = new CaptureFile(root);
    const close = vi.spyOn(OwnedFileHandle.prototype, "close");
    close.mockRejectedValueOnce(new Error("close denied"));
    close.mockRejectedValueOnce(new Error("close denied"));
    const failure = await captureFile
      .publish({ id: "evidence" } as unknown as Evidence)
      .catch((cause: unknown) => cause);

    const error = failedCaptureError(
      failure,
      await discardFailedCapture(store, captureFile),
    ) as ProviderAdapterError;

    expect(error.cause).toBe(failure);
    expect(error.cleanup).toEqual({
      reason:
        "the unpublished capture file's handle could not be closed after a retry",
      resources: [captureFile.partial],
    });
    await captureFile.close();
    expect(error.cleanupIncomplete).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });
});

describe("failedCaptureError", () => {
  it("returns the failure itself when everything was cleaned up", () => {
    const failure = new Error("walk failed");
    expect(failedCaptureError(failure, [])).toBe(failure);
  });

  it("reports the processes a failed session left with the failure as its cause", () => {
    const failure = new Error("checkpoint failed");
    const error = failedCaptureError(
      new DesktopSessionCleanupError(failure, unreleasedProcesses(0)),
      [
        {
          reason:
            "the content the failed capture retained could not be removed",
          leases: [new AnalysisCleanupLease(async () => {}, ["/out/content"])],
        },
      ],
    );

    expect(error).toBeInstanceOf(ProviderAdapterError);
    const adapter = error as ProviderAdapterError;
    expect(adapter.cause).toBe(failure);
    expect(adapter.cleanup).toEqual({
      reason: `${PROCESS_REASON}; the content the failed capture retained could not be removed`,
      resources: [...PROCESS_RESOURCES, "/out/content"],
    });
    expect(adapter.userMessage).toContain("checkpoint failed");
  });

  it("keeps a typed failure as the cleanup primary", () => {
    const failure = new AnalysisInputError(
      "capture_desktop_application",
      { userMessage: "bad input", conformsToInputContract: true },
      [],
    );
    const error = failedCaptureError(failure, [
      {
        reason: "unpublished capture file remained",
        leases: [new AnalysisCleanupLease(async () => {}, ["/out/x"])],
      },
    ]) as ProviderAdapterError;

    expect(error.cleanupPrimary).toBe(failure);
    expect(error.userMessage).toContain("bad input");
  });
});

describe("projectFailure", () => {
  it.each([
    { oversized: false, category: "cancelled" },
    { oversized: true, category: "execution_failure" },
  ])(
    "preserves the physical read outcome beside final cancellation and cleanup (oversized: $oversized)",
    async ({ oversized, category }) => {
      const root = await createTestTempDirectory("desktop-inventory-cancel-");
      const entry = join(root, "notes.desktop");
      await writeFile(
        entry,
        oversized
          ? "x".repeat(1024 * 1024 + 1)
          : "[Desktop Entry]\nType=Application\nName=Notes\nExec=notes\n",
      );
      const controller = new AbortController();
      const reason = new Error("cancelled while closing the desktop entry");
      let owner: OwnedFileHandle | undefined;
      const close = vi
        .spyOn(OwnedFileHandle.prototype, "close")
        .mockImplementation(function (this: OwnedFileHandle) {
          // oxlint-disable-next-line typescript/no-this-alias -- Release the exact denied descriptor after the public call.
          owner = this;
          controller.abort(reason);
          return Promise.reject(new Error("close denied"));
        });
      try {
        const result = await captureDesktopApplication(
          {
            desktopEntry: entry,
            executable: undefined,
            arguments: [],
            output: join(root, "capture"),
            statePaths: [],
            excludes: [],
            maxDurationSeconds: 1,
            maxEntries: 10,
            maxFileBytes: 1024,
            maxContentBytes: 1024,
            packageFile: undefined,
          },
          {
            platform: "linux",
            callerDirectory: root,
            environment: {
              HOME: root,
              DISPLAY: ":controlled",
              REA_XPROP_COMMAND: process.execPath,
            },
            nextRequest: () => undefined,
            report: async () => {
              throw new Error(
                "inventory failure must precede target execution",
              );
            },
          },
          controller.signal,
        );
        expect(owner).toBeDefined();
        expect(result).toMatchObject({
          error: "Desktop capture failed",
          code: "cleanup_incomplete",
          category,
          details: { resources: [entry] },
        });
      } finally {
        close.mockRestore();
        await owner?.close();
      }
    },
  );

  it("keeps the owner of a resource the inventory could not release", async () => {
    const resources = new ArtifactResourceScope();
    let attempts = 0;
    const removed = await resources.release({
      kind: "lease",
      resource: "/tmp/rea-apt-keys-1",
      lease: {
        release: () => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new Error("busy"))
            : Promise.resolve();
        },
      },
    });
    if (removed.kind !== "failed") throw new Error("expected a failed release");

    const failure = resources.cleanupFailure({ kind: "completed" }, [removed]);

    const error = projectFailure(failure, undefined);

    expect(error).toBeInstanceOf(ProviderAdapterError);
    expect(error.cleanupResources).toEqual(["/tmp/rea-apt-keys-1"]);
    await Promise.all(
      failure.cleanupLeases?.map((lease) => lease.release()) ?? [],
    );
    expect(attempts).toBe(2);
    expect(error.cleanupIncomplete).toBe(false);
  });
});
