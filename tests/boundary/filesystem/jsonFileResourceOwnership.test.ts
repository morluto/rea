import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { readJsonFile } from "../../../src/application/JsonFiles.js";
import { RegularFileCleanupFailure } from "../../../src/application/RegularFileRead.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("retains and retries a JSON file owner after a persistent close failure", async () => {
  const root = await createTestTempDirectory("rea-json-file-owner-");
  const path = join(root, "input.json");
  await writeFile(path, '{"value":"retained"}');
  const resources = new ArtifactResourceScope();
  const closeFailure = new Error("injected persistent close failure");
  let attempts = 0;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async () => {
      attempts += 1;
      throw closeFailure;
    });
  let failure: unknown;
  try {
    try {
      await readJsonFile(path, undefined, resources);
    } catch (cause: unknown) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
    if (!(failure instanceof RegularFileCleanupFailure))
      throw new Error("Expected the failed file owner to remain visible");
    expect(failure.cleanupCause).toBe(closeFailure);
    expect(failure.outcome).toMatchObject({
      kind: "completed",
      value: { ok: true, value: { value: "retained" } },
    });
    expect(failure.owner.handle.fd).toBeGreaterThanOrEqual(0);
    expect(attempts).toBe(2);
  } finally {
    close.mockRestore();
    await resources.close();
  }
  if (!(failure instanceof RegularFileCleanupFailure))
    throw new Error("Expected the retained file owner");
  expect(failure.owner.handle.fd).toBe(-1);
});

it("returns parsed JSON when a failed file close is recovered by the resource scope", async () => {
  const root = await createTestTempDirectory("rea-json-file-close-retry-");
  const path = join(root, "input.json");
  await writeFile(path, '{"value":"retained"}');
  const resources = new ArtifactResourceScope();
  const closeFailure = new Error("injected transient close failure");
  const originalClose = OwnedFileHandle.prototype.close;
  let attempts = 0;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      attempts += 1;
      if (attempts === 1) throw closeFailure;
      await originalClose.call(this);
    });
  try {
    const parsed = await readJsonFile(path, undefined, resources);
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value).toEqual({ value: "retained" });
    expect(attempts).toBe(2);
  } finally {
    close.mockRestore();
    await resources.close();
  }
});
