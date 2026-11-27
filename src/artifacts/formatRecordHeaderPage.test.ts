import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { readFormatRecordHeaderPage } from "./formatRecordHeaderPage.js";
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
