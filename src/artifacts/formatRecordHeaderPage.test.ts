import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { readFormatRecordHeaderPage } from "./formatRecordHeaderPage.js";
import { SystemdJournalArtifactReader } from "./SystemdJournalArtifactReader.js";
import {
  HEADER_BYTES,
  journalBytes,
} from "../domain/linux/systemdJournal.fixture.js";
import { ArtifactFileSource } from "../resources/ArtifactFileSource.js";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

const journal = async () => {
  const bytes = journalBytes({
    objects: Array.from({ length: 40 }, () => ({ type: 1, size: 32 })),
  });
  const directory = await createTestTempDirectory("rea-record-page-");
  const path = join(directory, "system.journal");
  await writeFile(path, bytes);
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

it("reads the window starting at the requested record", async () => {
  const { path, sha256 } = await journal();
  const items = await readFormatRecordHeaderPage({
    path,
    format: "systemd-journal",
    sha256,
    start: 36,
    limit: 2,
  });
  expect(items.map(({ offset }) => offset)).toEqual([
    HEADER_BYTES + 36 * 32,
    HEADER_BYTES + 37 * 32,
  ]);
});

it("stops a page cancelled mid-read and releases its reader", async () => {
  const { path, sha256 } = await journal();
  const controller = new AbortController();
  const read = ArtifactFileSource.prototype.read;
  // Abort once the page has bound its digest and started the windowed read.
  const spy = vi
    .spyOn(ArtifactFileSource.prototype, "read")
    .mockImplementation(async function (this: ArtifactFileSource, signal) {
      const admitted = await read.call(this, signal);
      controller.abort(new Error("caller stopped paging"));
      return admitted;
    });
  const resources = new ArtifactResourceScope();
  try {
    await expect(
      readFormatRecordHeaderPage({
        path,
        format: "systemd-journal",
        sha256,
        start: 32,
        limit: 8,
        signal: controller.signal,
        resources,
      }),
    ).rejects.toMatchObject({ reason: "cancelled" });
    // The reader's cleanup completed, so nothing is retained for retry.
    expect(resources.hasPending).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

it("keeps a completed page when its reader fails to close", async () => {
  const { path, sha256 } = await journal();
  const close = vi
    .spyOn(SystemdJournalArtifactReader.prototype, "close")
    .mockRejectedValueOnce(new Error("descriptor close failed"));
  const resources = new ArtifactResourceScope();
  const observed: unknown[] = [];
  try {
    await expect(
      readFormatRecordHeaderPage(
        {
          path,
          format: "systemd-journal",
          sha256,
          start: 38,
          limit: 8,
          resources,
        },
        (items) => {
          observed.push(items);
          return undefined;
        },
      ),
    ).rejects.toMatchObject({
      cleanup: { reason: "descriptor close failed", resources: [path] },
    });
    // The finished page reached the caller's observation before the failure.
    expect(observed).toEqual([
      [
        expect.objectContaining({ offset: HEADER_BYTES + 38 * 32 }),
        expect.objectContaining({ offset: HEADER_BYTES + 39 * 32 }),
      ],
    ]);
    // The reader stays retained for a cleanup retry.
    expect(resources.hasPending).toBe(true);
  } finally {
    close.mockRestore();
    await resources.retryCleanup().catch(() => undefined);
  }
});

it("retries a reader an earlier page failed to close before reading again", async () => {
  const { path, sha256 } = await journal();
  const close = vi
    .spyOn(SystemdJournalArtifactReader.prototype, "close")
    .mockRejectedValueOnce(new Error("descriptor close failed"));
  const resources = new ArtifactResourceScope();
  const request = {
    path,
    format: "systemd-journal",
    sha256,
    start: 32,
    limit: 8,
    resources,
  };
  try {
    await expect(readFormatRecordHeaderPage(request)).rejects.toMatchObject({
      cleanup: { resources: [path] },
    });
    expect(resources.hasPending).toBe(true);
    // The next page first retries the retained reader through the scope.
    await expect(readFormatRecordHeaderPage(request)).resolves.toHaveLength(8);
    expect(resources.hasPending).toBe(false);
    expect(close).toHaveBeenCalledTimes(3);
  } finally {
    close.mockRestore();
  }
});

it("refuses a format that declares no record window", async () => {
  const { path, sha256 } = await journal();
  await expect(
    readFormatRecordHeaderPage({
      path,
      format: "zip",
      sha256,
      start: 0,
      limit: 8,
    }),
  ).rejects.toMatchObject({ reason: "unavailable" });
});
