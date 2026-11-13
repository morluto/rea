import { createHash } from "node:crypto";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import * as stableArtifact from "../../artifacts/readStableArtifact.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { inspectNtfsJournalEvidence } from "./NtfsJournalService.js";
import { parseEvidence } from "../../domain/evidence.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

it.each([
  ["EACCES", "access_denied"],
  ["EIO", "artifact_operation_failed"],
])(
  "preserves the acquisition failure category for %s",
  async (systemCode, expectedCode) => {
    const resources = new ArtifactResourceScope();
    const spy = vi
      .spyOn(stableArtifact, "readStableArtifact")
      .mockRejectedValueOnce(
        Object.assign(new Error("acquisition read failed"), {
          code: systemCode,
        }),
      );
    try {
      const result = await inspectNtfsJournalEvidence(
        {
          mft_path: "/fixture/mft",
          journal_path: "/fixture/journal",
        },
        resources,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected acquisition failure");
      expect(projectAnalysisError(result.error).code).toBe(expectedCode);
    } finally {
      spy.mockRestore();
      await resources.close();
    }
  },
);

it("preserves the completed file identity when MFT interpretation fails", async () => {
  const resources = new ArtifactResourceScope();
  const bytes = Buffer.from("not an MFT");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = await createTestTempDirectory("rea-ntfs-format-refusal-");
  const mftPath = join(directory, "mft");
  await writeFile(mftPath, bytes);
  const spy = vi.spyOn(stableArtifact, "readStableArtifact");
  try {
    const result = await inspectNtfsJournalEvidence(
      {
        mft_path: mftPath,
        journal_path: "/fixture/journal",
      },
      resources,
    );
    if (result.ok) throw new Error("expected format failure");
    expect(result.error.partialObservation).toEqual({
      kind: "file-snapshot-hash",
      path: mftPath,
      sha256,
      bytes: bytes.length,
    });
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
    await resources.close();
  }
});

it("retains both acquisitions through a failed journal close and cleanup retry", async () => {
  const directory = await createTestTempDirectory("rea-ntfs-partial-");
  const mftPath = join(directory, "mft");
  const journalPath = join(directory, "journal");
  const mft = Buffer.alloc(1024);
  mft.write("FILE");
  mft.writeUInt16LE(48, 4);
  mft.writeUInt16LE(3, 6);
  mft.writeUInt16LE(56, 20);
  mft.writeUInt32LE(64, 24);
  mft.writeUInt32LE(1024, 28);
  mft.writeUInt32LE(0xffffffff, 56);
  for (const offset of [48, 510, 1022]) mft.writeUInt16LE(1, offset);
  const journal = Buffer.from("acquired journal bytes");
  await writeFile(mftPath, mft);
  await writeFile(journalPath, journal);
  const resources = new ArtifactResourceScope();
  const read = stableArtifact.readStableArtifact;
  let restoreClose: (() => void) | undefined;
  let failNextClose = true;
  const spy = vi
    .spyOn(stableArtifact, "readStableArtifact")
    .mockImplementation(
      (path, maximumBytes, signal, fileSystem, scope, observed) =>
        read(
          path,
          maximumBytes,
          signal,
          path === journalPath
            ? {
                lstat: (selected) => lstat(selected, { bigint: true }),
                realpath,
                open: async (selected, flags) => {
                  const handle = await open(selected, flags);
                  if (failNextClose) {
                    failNextClose = false;
                    const close = vi
                      .spyOn(handle, "close")
                      .mockRejectedValueOnce(new Error("close failed"));
                    restoreClose = () => close.mockRestore();
                  }
                  return handle;
                },
              }
            : fileSystem,
          scope,
          observed,
        ),
    );
  try {
    const result = await inspectNtfsJournalEvidence(
      {
        mft_path: mftPath,
        journal_path: journalPath,
        mft_record_limit: 1,
      },
      resources,
    );
    if (result.ok) throw new Error("expected journal cleanup failure");
    expect(result.error.cleanupIncomplete).toBe(true);
    const partial = parseEvidence(result.error.partialObservation);
    expect(partial.normalized_result).toMatchObject({
      kind: "ntfs-journal-partial",
      mft: {
        sha256: createHash("sha256").update(mft).digest("hex"),
        metadata: {
          record_count: 1,
          record_headers: [{ index: 0, attributeCoverage: "complete" }],
        },
      },
      journal_observation: {
        kind: "file-snapshot-hash",
        path: journalPath,
        sha256: createHash("sha256").update(journal).digest("hex"),
        bytes: journal.length,
      },
    });
    const retry = await inspectNtfsJournalEvidence(
      { mft_path: mftPath, journal_path: journalPath },
      resources,
    );
    if (!retry.ok) throw retry.error;
    expect(spy).toHaveBeenCalledTimes(4);
    await resources.close();
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(
      projectAnalysisError(result.error).details?.partial_observation,
    ).toEqual(partial);
  } finally {
    spy.mockRestore();
    await resources.close();
    restoreClose?.();
  }
});
