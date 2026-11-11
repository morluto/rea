import {
  lstat,
  open,
  realpath,
  rename,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import * as stableArtifact from "../../artifacts/readStableArtifact.js";
import * as mftDecoder from "../../domain/windows/ntfsMft.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { parseEvidence } from "../../domain/evidence.js";
import { ntfsJournalResultSchema } from "../../domain/windows/ntfsJournalQuery.js";
import { inspectNtfsJournalEvidence } from "./NtfsJournalService.js";
import { createDeferred } from "../../../tests/fixtures/binarySession.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

const acquisitions = async () => {
  const root = await createTestTempDirectory("rea-ntfs-cache-");
  const mftPath = join(root, "mft"),
    journalPath = join(root, "journal");
  const mft = Buffer.alloc(1024);
  mft.write("FILE");
  mft.writeUInt16LE(48, 4);
  mft.writeUInt16LE(3, 6);
  mft.writeUInt16LE(2, 16);
  mft.writeUInt16LE(56, 20);
  mft.writeUInt32LE(64, 24);
  mft.writeUInt32LE(1024, 28);
  mft.writeUInt32LE(0xffffffff, 56);
  for (const offset of [48, 510, 1022]) mft.writeUInt16LE(1, offset);
  const journal = Buffer.alloc(192);
  for (let offset = 0; offset < 192; offset += 64) {
    journal.writeUInt32LE(64, offset);
    journal.writeUInt16LE(2, offset + 4);
    journal.writeBigUInt64LE(2n << 48n, offset + 8);
    journal.writeBigInt64LE(BigInt(offset), offset + 24);
    journal.writeUInt16LE(60, offset + 58);
  }
  await writeFile(mftPath, mft);
  await writeFile(journalPath, journal);
  return {
    root,
    mftPath,
    journalPath,
    mft,
    journal,
    input: { mft_path: mftPath, journal_path: journalPath, max_rows: 1 },
  };
};

it("walks source-order pages with one physical acquisition and one MFT interpretation per scope", async () => {
  const fixture = await acquisitions(),
    resources = new ArtifactResourceScope();
  const reads = vi.spyOn(stableArtifact, "readStableArtifact");
  const parses = vi.spyOn(mftDecoder, "parseMftIndex");
  try {
    const values: string[] = [];
    for (const offset of [0, 64, 128]) {
      const result = await inspectNtfsJournalEvidence(
        { ...fixture.input, start_file_offset: offset },
        resources,
      );
      if (!result.ok) throw result.error;
      const normalized = ntfsJournalResultSchema.parse(
        result.value.normalized_result,
      );
      const row = normalized.rows[0];
      if (row?.kind !== "event") throw new Error("Missing selected event");
      values.push(row.event.usn);
    }
    expect(values).toEqual(["0", "64", "128"]);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(parses).toHaveBeenCalledTimes(1);
  } finally {
    reads.mockRestore();
    parses.mockRestore();
    await resources.close();
  }
});

it("refuses changed MFT bytes even after mtime restoration, then admits an explicit retry with a new identity", async () => {
  const fixture = await acquisitions(),
    resources = new ArtifactResourceScope();
  const reads = vi.spyOn(stableArtifact, "readStableArtifact");
  try {
    const first = await inspectNtfsJournalEvidence(fixture.input, resources);
    if (!first.ok) throw first.error;
    const original = await lstat(fixture.mftPath);
    fixture.mft.writeUInt16LE(3, 16);
    await writeFile(fixture.mftPath, fixture.mft);
    await utimes(fixture.mftPath, original.atime, original.mtime);
    const changed = await inspectNtfsJournalEvidence(fixture.input, resources);
    if (changed.ok) throw new Error("returned stale MFT facts");
    expect(projectAnalysisError(changed.error).code).toBe("artifact_changed");
    expect(reads).toHaveBeenCalledTimes(2);
    const retry = await inspectNtfsJournalEvidence(fixture.input, resources);
    if (!retry.ok) throw retry.error;
    expect(retry.value.normalized_result).toMatchObject({
      rows: [{ event: { mft: { file: { kind: "unresolved" } } } }],
    });
    expect(reads).toHaveBeenCalledTimes(4);
  } finally {
    reads.mockRestore();
    await resources.close();
  }
});

it("rejects same-content journal replacement and retains the completed MFT observation", async () => {
  const fixture = await acquisitions(),
    resources = new ArtifactResourceScope();
  try {
    const first = await inspectNtfsJournalEvidence(fixture.input, resources);
    if (!first.ok) throw first.error;
    const replacement = join(fixture.root, "replacement");
    await writeFile(replacement, fixture.journal);
    await rename(replacement, fixture.journalPath);
    const changed = await inspectNtfsJournalEvidence(fixture.input, resources);
    if (changed.ok) throw new Error("accepted a replaced selected file");
    expect(projectAnalysisError(changed.error).code).toBe("artifact_changed");
    expect(
      parseEvidence(changed.error.partialObservation).normalized_result,
    ).toMatchObject({
      kind: "ntfs-journal-partial",
      mft: { metadata: { record_count: 1 } },
      journal_observation: { kind: "file-snapshot-hash" },
    });
  } finally {
    await resources.close();
  }
});

it("evicts the prior pair instead of accumulating buffers and refuses admission after close", async () => {
  const a = await acquisitions(),
    b = await acquisitions(),
    resources = new ArtifactResourceScope();
  const reads = vi.spyOn(stableArtifact, "readStableArtifact");
  try {
    for (const input of [a.input, b.input, a.input])
      expect((await inspectNtfsJournalEvidence(input, resources)).ok).toBe(
        true,
      );
    expect(reads).toHaveBeenCalledTimes(6);
    await resources.close();
    expect((await inspectNtfsJournalEvidence(a.input, resources)).ok).toBe(
      false,
    );
    expect(reads).toHaveBeenCalledTimes(6);
  } finally {
    reads.mockRestore();
    await resources.close();
  }
});

it("keeps an active acquisition independent of a cancelled peer, bounds concurrent admission, and joins close", async () => {
  const fixture = await acquisitions(),
    resources = new ArtifactResourceScope();
  const entered = createDeferred<void>(),
    release = createDeferred<void>();
  const read = stableArtifact.readStableArtifact;
  const reads = vi
    .spyOn(stableArtifact, "readStableArtifact")
    .mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return read(...args);
    });
  try {
    const active = inspectNtfsJournalEvidence(fixture.input, resources);
    await entered.promise;
    const cancelled = new AbortController();
    cancelled.abort("peer cancelled");
    const peer = await inspectNtfsJournalEvidence(
      fixture.input,
      resources,
      cancelled.signal,
    );
    if (peer.ok) throw new Error("accepted cancelled peer");
    expect(projectAnalysisError(peer.error).code).toBe("cancelled");
    const busy = await inspectNtfsJournalEvidence(fixture.input, resources);
    if (busy.ok) throw new Error("exceeded acquisition capacity");
    expect(projectAnalysisError(busy.error).code).toBe("resource_constraint");
    let closed = false;
    const closing = resources.close().then(() => {
      closed = true;
    });
    expect(closed).toBe(false);
    release.resolve();
    expect((await active).ok).toBe(true);
    await closing;
    expect(reads).toHaveBeenCalledTimes(2);
  } finally {
    release.resolve();
    reads.mockRestore();
    await resources.close();
  }
});

it("does not cache acquisitions cancelled during the final journal close", async () => {
  const fixture = await acquisitions(),
    resources = new ArtifactResourceScope();
  const controller = new AbortController();
  const read = stableArtifact.readStableArtifact;
  let cancelOnClose = true;
  const reads = vi
    .spyOn(stableArtifact, "readStableArtifact")
    .mockImplementation((path, maximum, signal, fs, scope, state) =>
      read(
        path,
        maximum,
        signal,
        path === fixture.journalPath
          ? {
              lstat: (selected) => lstat(selected, { bigint: true }),
              realpath,
              open: async (selected, flags) => {
                const file = await open(selected, flags),
                  close = file.close.bind(file);
                file.close = async () => {
                  if (cancelOnClose) {
                    cancelOnClose = false;
                    controller.abort("final cleanup");
                  }
                  await close();
                };
                return file;
              },
            }
          : fs,
        scope,
        state,
      ),
    );
  try {
    const cancelled = await inspectNtfsJournalEvidence(
      fixture.input,
      resources,
      controller.signal,
    );
    if (cancelled.ok) throw new Error("ignored finalization cancellation");
    expect(projectAnalysisError(cancelled.error).code).toBe("cancelled");
    expect(
      parseEvidence(cancelled.error.partialObservation).normalized_result,
    ).toMatchObject({ kind: "ntfs-journal-partial" });
    expect(
      (await inspectNtfsJournalEvidence(fixture.input, resources)).ok,
    ).toBe(true);
    expect(reads).toHaveBeenCalledTimes(4);
  } finally {
    reads.mockRestore();
    await resources.close();
  }
});

it.each([
  ["EACCES", "access_denied"],
  ["EIO", "artifact_operation_failed"],
])(
  "preserves %s during cached source validation and allows a fresh retry",
  async (systemCode, expectedCode) => {
    const fixture = await acquisitions(),
      resources = new ArtifactResourceScope();
    const reads = vi.spyOn(stableArtifact, "readStableArtifact");
    const validate = vi.spyOn(stableArtifact, "assertStableArtifactState");
    try {
      expect(
        (await inspectNtfsJournalEvidence(fixture.input, resources)).ok,
      ).toBe(true);
      validate.mockRejectedValueOnce(
        Object.assign(new Error("source validation failed"), {
          code: systemCode,
        }),
      );
      const failed = await inspectNtfsJournalEvidence(fixture.input, resources);
      if (failed.ok) throw new Error("returned an unverified cache entry");
      expect(projectAnalysisError(failed.error).code).toBe(expectedCode);
      expect(reads).toHaveBeenCalledTimes(2);
      expect(
        (await inspectNtfsJournalEvidence(fixture.input, resources)).ok,
      ).toBe(true);
      expect(reads).toHaveBeenCalledTimes(4);
    } finally {
      reads.mockRestore();
      validate.mockRestore();
      await resources.close();
    }
  },
);
