import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { ArtifactReaderFailure } from "../../resources/ArtifactReader.js";
import { OwnedStagedOutput } from "../../filesystem/OwnedStagedOutput.js";
import {
  ExportPublishedCleanupFailure,
  ExportResources,
} from "./exportResources.js";

it.each([false, true])(
  "retains publication outcome and staging cleanup authority (conflict: %s)",
  async (conflict) => {
    const root = await createTestTempDirectory("rea-export-resources-");
    const destination = join(root, "published");
    if (conflict) await writeFile(destination, "existing");
    const lease = { release: vi.fn(async () => undefined) };
    const resources = new ExportResources(
      root,
      await lstat(root, { bigint: true }),
      lease,
      undefined,
    );
    const cleanupFailure = new Error("staging removal denied");
    const close = vi.spyOn(OwnedStagedOutput.prototype, "close");
    close.mockRejectedValueOnce(cleanupFailure);
    try {
      const cause: unknown = await resources
        .publish("new", destination, "link")
        .catch((failure: unknown) => failure);
      expect(cause).toBeInstanceOf(ArtifactReaderFailure);
      const failure = cause as ArtifactReaderFailure;
      expect(failure.cleanup?.reason).toContain("staging removal denied");
      expect(failure.cleanupLeases).toHaveLength(1);
      if (conflict) {
        expect(failure).not.toBeInstanceOf(ExportPublishedCleanupFailure);
        expect(failure.message).toContain("EEXIST");
        expect(failure.cause).toBeInstanceOf(ArtifactReaderFailure);
      } else {
        expect(failure).toBeInstanceOf(ExportPublishedCleanupFailure);
        expect((failure as ExportPublishedCleanupFailure).publishedPath).toBe(
          destination,
        );
        expect(failure.message).toBe("staging removal denied");
      }
      expect(await readFile(destination, "utf8")).toBe(
        conflict ? "existing" : "new",
      );
      expect(
        (await readdir(root)).some((name) =>
          name.startsWith(".decompile-stage-"),
        ),
      ).toBe(true);
      expect(lease.release).not.toHaveBeenCalled();
      await expect(resources.close()).resolves.toEqual({
        ok: true,
        value: undefined,
      });
      expect(await readdir(root)).toEqual(["published"]);
      expect(failure.cleanupLeases?.[0]?.released).toBe(true);
      expect(lease.release).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
      await resources.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("retains the source failure's parsed facts and cancellation identity", () => {
  const reason = { request: "cancel after publication" };
  const details = {
    logicalPath: "source",
    unpacked: false,
    declaredSha256: null,
    calculatedSha256: null,
  } as const;
  const admission = {
    kind: "asar-header",
    maximumBytes: 123,
    source: "setting",
  } as const;
  const original = new ArtifactReaderFailure(
    "cancelled",
    "interrupted",
    {
      cause: reason,
      cancellation: { reason },
      userMessage: "Selected publication was interrupted.",
      resolvedPath: "/resolved/source",
      boundary: "capacity",
      admission,
      integrityCheck: "read-coverage",
    },
    details,
  );
  const published = new ExportPublishedCleanupFailure(
    "/output/index",
    original,
  );
  expect(published.cancellation?.reason).toBe(reason);
  expect(published.primaryFacts()).toEqual(original.primaryFacts());
  expect(published.integrityCheck).toBe("read-coverage");
  expect(published.details).toEqual(details);
  expect(published.cause).toBe(original);
});

it("stages without publishing, discards unpublished bytes, and reports a staging failure at publication", async () => {
  const root = await createTestTempDirectory("rea-export-staging-");
  const lease = { release: vi.fn(async () => undefined) };
  const identity = await lstat(root, { bigint: true });
  const resources = new ExportResources(root, identity, lease, undefined);
  // A staging directory cannot be created inside a missing root.
  const missing = new ExportResources(
    join(root, "absent"),
    identity,
    lease,
    undefined,
  );
  try {
    const [kept, dropped] = await Promise.all([
      resources.stage("kept"),
      resources.stage("dropped"),
    ]);
    // Staged bytes have no final name yet.
    const staged = await readdir(root);
    expect(staged).toHaveLength(2);
    expect(staged.every((name) => name.startsWith(".decompile-stage-"))).toBe(
      true,
    );
    await resources.discardStaged(dropped);
    await resources.publishStaged(kept, join(root, "published"), "link");
    expect(await readdir(root)).toEqual(["published"]);
    expect(await readFile(join(root, "published"), "utf8")).toBe("kept");

    const failed = await missing.stage("unstaged");
    expect(failed.owner).toBeUndefined();
    await expect(
      missing.publishStaged(failed, join(root, "never"), "link"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await missing.discardStaged(failed);
    expect(await readdir(root)).toEqual(["published"]);
  } finally {
    await resources.close();
    await rm(root, { recursive: true, force: true });
  }
});
