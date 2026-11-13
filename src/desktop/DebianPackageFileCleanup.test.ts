import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactFileCleanupFailure } from "../artifacts/ArtifactFileOperation.js";
import { DPKG_DEB_OUTPUT } from "../domain/desktop/debianPackageFile.fixture.js";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";
import { observeStableFile } from "../filesystem/StableFileHash.js";
import { inspectPackageFile } from "./DebianPackageFile.js";

vi.mock("../filesystem/StableFileHash.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../filesystem/StableFileHash.js")>()),
  observeStableFile: vi.fn(),
}));

it("throws a failed close with its cleanup owner even when the capture was cancelled meanwhile", async () => {
  const folder = await createTestTempDirectory("desktop-deb-close-");
  const path = join(folder, "varicad2026-en_2.03_amd64.deb");
  await writeFile(path, "!<arch>\n");
  const cancel = new AbortController();
  const close = vi.fn(async () => undefined);
  const owner = { close } as never;
  vi.mocked(observeStableFile).mockImplementation(async (file, options) => {
    options.retainFailedClose(owner);
    cancel.abort();
    throw new RegularFileCleanupFailure({
      path: file,
      owner,
      outcome: { kind: "failed", cause: new Error("read failed") },
      cleanupCause: new Error("descriptor close failed"),
    });
  });

  const inspected = inspectPackageFile(
    path,
    {
      kind: "deb",
      name: "varicad2026-en",
      version: "1:2.03-1",
      architecture: "amd64",
      sources: [],
      package_lists_present: true,
    },
    async () => ({ stdout: DPKG_DEB_OUTPUT, exitCode: 0 }),
    cancel.signal,
  );

  const failure = await inspected.catch((error: unknown) => error);
  if (!(failure instanceof ArtifactFileCleanupFailure)) throw failure;
  expect(failure.fileCleanupFailure.owner).toBe(owner);
  expect(failure.fileCleanupFailure.path).toBe(path);
  expect(close).not.toHaveBeenCalled();
  await failure.cleanupLease.release();
  expect(close).toHaveBeenCalledTimes(1);
});
