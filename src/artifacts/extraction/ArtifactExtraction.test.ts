let lstatOverride:
  | ((targetPath: string) => Promise<never> | undefined)
  | undefined;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: (async (...args: Parameters<typeof actual.lstat>) => {
      const targetPath = String(args[0]);
      const overridden = lstatOverride?.(targetPath);
      if (overridden !== undefined) return overridden;
      return actual.lstat(...args);
    }) as typeof actual.lstat,
  };
});

import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it, vi } from "vitest";

import { asarHeaderBytes } from "../../../tests/fixtures/asarHeader.js";
import { AsarArtifactReader } from "../AsarArtifactReader.js";
import { DestinationCaseCollisionFailure } from "../ArtifactPaths.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import { ArtifactResourceScope } from "../ArtifactResourceScope.js";
import { OwnedDirectoryHandle } from "../../filesystem/OwnedDirectoryHandle.js";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import { openRegularFile } from "../../filesystem/RegularFile.js";
import { SafeOutputTree } from "../SafeOutputTree.js";
import { ZipArtifactReader } from "../ZipArtifactReader.js";
import { DirectoryArtifactReader } from "../DirectoryArtifactReader.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  DRY_RUN_NON_ASCII_CASE_LIMITATION,
  DRY_RUN_NON_FILE_DRIFT_SUMMARY_LIMITATION,
  DRY_RUN_NON_FILE_RECONCILIATION_LIMITATION,
  DRY_RUN_OVER_LIMIT_LIMITATION,
  DRY_RUN_UNKNOWN_CASE_LIMITATION,
  DRY_RUN_UNRESOLVED_LIMITATION,
  DRY_RUN_VALIDATED_LIMITATION,
  extractArtifact,
  formatDryRunNonFileAddedLimitation,
  formatDryRunNonFileKindMismatchReason,
  formatDryRunOversizedEntryLimitation,
  formatDryRunPlanPageLimitation,
  formatExtractionIntegrityContradictionLimitation,
  MAX_DRY_RUN_PLAN_PAGE_BYTES,
} from "./ArtifactExtraction.js";

const zipBytes = async (content?: string): Promise<Buffer> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  if (content !== undefined)
    await writer.add("member.txt", new TextReader(content));
  return Buffer.from(await writer.close());
};

const zipInput = (
  path: string,
  outputRoot: string,
  resourceScope: ArtifactResourceScope,
) => ({
  inputPath: path,
  inputFormat: "zip" as const,
  outputRoot,
  environment: {},
  integrityPolicy: "fail" as const,
  resourceScope,
});

/** Intercept only the exact admitted root owner, including its later retry. */
const watchZipRootClose = (
  scope: ArtifactResourceScope,
  path: string,
  close: (original: () => Promise<void>, attempt: number) => Promise<void>,
): { readonly attempts: () => number; readonly restore: () => void } => {
  const originalRelease = scope.release.bind(scope);
  let rootCloseSpy: { mockRestore(): void } | undefined;
  let attempts = 0;
  const releaseSpy = vi
    .spyOn(scope, "release")
    .mockImplementation(async (owner) => {
      if (
        owner.kind === "file-handle" &&
        owner.resource === `root artifact descriptor for ${path}`
      ) {
        const originalClose = owner.handle.close.bind(owner.handle);
        rootCloseSpy = vi
          .spyOn(owner.handle, "close")
          .mockImplementation(() => close(originalClose, ++attempts));
      }
      return originalRelease(owner);
    });
  return {
    attempts: () => attempts,
    restore: () => {
      rootCloseSpy?.mockRestore();
      releaseSpy.mockRestore();
    },
  };
};

it.each(["archive", "directory", "missing"] as const)(
  "extracts from the inventoried ZIP descriptor when its pathname becomes %s",
  async (replacement) => {
    const directory = await createTestTempDirectory(
      "rea-zip-extraction-identity-",
    );
    const path = join(directory, "source.zip");
    const original = await zipBytes("unchanged");
    await writeFile(path, original);
    const output = join(directory, "out");
    const resourceScope = new ArtifactResourceScope();
    const open = vi.mocked(openRegularFile);
    open.mockClear();
    const directoryEntries = vi.spyOn(
      DirectoryArtifactReader.prototype,
      "entries",
    );
    const originalClose = ZipArtifactReader.prototype.close;
    let closes = 0;
    const close = vi
      .spyOn(ZipArtifactReader.prototype, "close")
      .mockImplementation(async function (this: ZipArtifactReader) {
        await originalClose.call(this);
        if (++closes !== 1) return;
        await rename(path, join(directory, "original.zip"));
        if (replacement === "directory") await mkdir(path);
        if (replacement === "archive") {
          // EOCD comment changes the carrier digest while every member stays identical.
          const changed = Buffer.from(original);
          changed.writeUInt16LE(1, changed.length - 2);
          await writeFile(path, Buffer.concat([changed, Buffer.from("B")]));
        }
      });
    try {
      const outcome = await extractArtifact(
        zipInput(path, output, resourceScope),
      )
        .then((result) => ({ kind: "completed" as const, result }))
        .catch((cause: unknown) => ({ kind: "failed" as const, cause }));
      if (outcome.kind === "failed") {
        // Renaming the admitted inode can change its ctime. Refusal is valid;
        // reading the replacement carrier or directory is not.
        expect(outcome.cause).toMatchObject({ reason: "integrity" });
        await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(outcome.result.manifest.root_format).toBe("zip");
        expect(outcome.result.artifacts).toMatchObject([
          { relative_path: "member.txt" },
        ]);
        expect(await readFile(join(output, "member.txt"), "utf8")).toBe(
          "unchanged",
        );
      }
      expect(open).toHaveBeenCalledTimes(1);
      expect(directoryEntries).not.toHaveBeenCalled();
      expect(closes).toBe(2);
    } finally {
      close.mockRestore();
      directoryEntries.mockRestore();
      await resourceScope.close();
    }
  },
);

it("preserves cancellation raised during final ZIP descriptor close", async () => {
  const directory = await createTestTempDirectory("rea-zip-extraction-cancel-");
  const path = join(directory, "empty.zip");
  const bytes = await zipBytes();
  await writeFile(path, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const output = join(directory, "out");
  const resourceScope = new ArtifactResourceScope();
  const controller = new AbortController();
  const reason = new Error("cancel during root close");
  let readerCloses = 0;
  const originalReaderClose = ZipArtifactReader.prototype.close;
  const readerClose = vi
    .spyOn(ZipArtifactReader.prototype, "close")
    .mockImplementation(async function (this: ZipArtifactReader) {
      readerCloses += 1;
      await originalReaderClose.call(this);
    });
  let outputExistedAtRootClose = false;
  let readerClosesAtRootClose = 0;
  const rootClose = watchZipRootClose(resourceScope, path, async (original) => {
    outputExistedAtRootClose = await stat(output).then(
      () => true,
      () => false,
    );
    readerClosesAtRootClose = readerCloses;
    controller.abort(reason);
    await original();
  });
  try {
    await expect(
      extractArtifact(zipInput(path, output, resourceScope), controller.signal),
    ).rejects.toMatchObject({
      reason: "cancelled",
      cause: reason,
      partialObservation: {
        kind: "artifact-inventory",
        inventory: {
          manifest: { root_format: "zip", root_sha256: digest },
          coverage: { scope: "container-entries", status: "complete" },
        },
      },
    });
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(outputExistedAtRootClose).toBe(true);
    expect(readerClosesAtRootClose).toBe(2);
    expect(rootClose.attempts()).toBe(1);
    expect(resourceScope.hasPending).toBe(false);
  } finally {
    await resourceScope.close();
    rootClose.restore();
    readerClose.mockRestore();
  }
});

it("retains completed ZIP inventory when cancellation arrives during inventory reader close", async () => {
  const directory = await createTestTempDirectory(
    "rea-zip-inventory-close-cancel-",
  );
  const path = join(directory, "empty.zip");
  const bytes = await zipBytes();
  await writeFile(path, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const output = join(directory, "out");
  const resourceScope = new ArtifactResourceScope();
  const controller = new AbortController();
  const reason = new Error("cancel during inventory reader close");
  const originalReaderClose = ZipArtifactReader.prototype.close;
  let readerCloses = 0;
  const readerClose = vi
    .spyOn(ZipArtifactReader.prototype, "close")
    .mockImplementation(async function (this: ZipArtifactReader) {
      readerCloses += 1;
      await originalReaderClose.call(this);
      if (readerCloses === 1) controller.abort(reason);
    });
  const rootClose = watchZipRootClose(resourceScope, path, (original) =>
    original(),
  );
  try {
    await expect(
      extractArtifact(zipInput(path, output, resourceScope), controller.signal),
    ).rejects.toMatchObject({
      reason: "cancelled",
      cause: reason,
      partialObservation: {
        kind: "artifact-inventory",
        inventory: {
          manifest: { root_format: "zip", root_sha256: digest },
          coverage: { scope: "container-entries", status: "complete" },
        },
      },
    });
    expect(readerCloses).toBe(1);
    expect(rootClose.attempts()).toBe(1);
    expect(resourceScope.hasPending).toBe(false);
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await resourceScope.close();
    rootClose.restore();
    readerClose.mockRestore();
  }
});

it("retains and retries a failed final ZIP descriptor close", async () => {
  const directory = await createTestTempDirectory("rea-zip-extraction-close-");
  const path = join(directory, "empty.zip");
  await writeFile(path, await zipBytes());
  const output = join(directory, "out");
  const resourceScope = new ArtifactResourceScope();
  const failure = new Error("root close denied");
  const rootClose = watchZipRootClose(
    resourceScope,
    path,
    (original, attempt) =>
      attempt === 1 ? Promise.reject(failure) : original(),
  );
  try {
    await expect(
      extractArtifact(zipInput(path, output, resourceScope)),
    ).rejects.toMatchObject({ cleanup: { reason: failure.message } });
    expect(resourceScope.cleanupResources).toEqual([
      `root artifact descriptor for ${path}`,
    ]);
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    await resourceScope.close();
    expect(rootClose.attempts()).toBe(2);
    expect(resourceScope.hasPending).toBe(false);
  } finally {
    await resourceScope.close().catch(() => undefined);
    rootClose.restore();
  }
});

it("retains both failed ZIP inventory owners and retries only those owners", async () => {
  const directory = await createTestTempDirectory("rea-zip-inventory-close-");
  const path = join(directory, "empty.zip");
  await writeFile(path, await zipBytes());
  const resourceScope = new ArtifactResourceScope();
  const originalReaderClose = ZipArtifactReader.prototype.close;
  let readerAttempts = 0;
  const readerClose = vi
    .spyOn(ZipArtifactReader.prototype, "close")
    .mockImplementation(async function (this: ZipArtifactReader) {
      if (++readerAttempts === 1) throw new Error("reader close denied");
      await originalReaderClose.call(this);
    });
  const rootClose = watchZipRootClose(
    resourceScope,
    path,
    (original, attempt) =>
      attempt === 1
        ? Promise.reject(new Error("root close denied"))
        : original(),
  );
  try {
    await expect(
      extractArtifact(zipInput(path, join(directory, "out"), resourceScope)),
    ).rejects.toMatchObject({
      cleanup: {
        resources: [
          `artifact reader for ${path}`,
          `root artifact descriptor for ${path}`,
        ],
      },
    });
    expect(resourceScope.cleanupResources).toEqual([
      `artifact reader for ${path}`,
      `root artifact descriptor for ${path}`,
    ]);
    await resourceScope.close();
    expect(readerAttempts).toBe(2);
    expect(rootClose.attempts()).toBe(2);
  } finally {
    await resourceScope.close().catch(() => undefined);
    rootClose.restore();
    readerClose.mockRestore();
  }
});

it.each([false, true] as const)(
  "retains failed extraction reader cleanup when ZIP root close also fails: %s",
  async (failRootClose) => {
    const directory = await createTestTempDirectory(
      "rea-zip-extraction-mixed-close-",
    );
    const path = join(directory, "empty.zip");
    await writeFile(path, await zipBytes());
    const output = join(directory, "out");
    const resourceScope = new ArtifactResourceScope();
    const originalReaderClose = ZipArtifactReader.prototype.close;
    const readerFailure = new Error("extraction reader close denied");
    const rootFailure = new Error("root close denied");
    let readerAttempts = 0;
    const readerClose = vi
      .spyOn(ZipArtifactReader.prototype, "close")
      .mockImplementation(async function (this: ZipArtifactReader) {
        readerAttempts += 1;
        if (readerAttempts === 2) throw readerFailure;
        await originalReaderClose.call(this);
      });
    const rootClose = watchZipRootClose(
      resourceScope,
      path,
      (original, attempt) =>
        failRootClose && attempt === 1
          ? Promise.reject(rootFailure)
          : original(),
    );
    try {
      await expect(
        extractArtifact(zipInput(path, output, resourceScope)),
      ).rejects.toMatchObject({
        cleanup: {
          resources: failRootClose
            ? [
                `artifact reader for ${path}`,
                `root artifact descriptor for ${path}`,
              ]
            : [`artifact reader for ${path}`],
        },
      });
      expect(resourceScope.cleanupResources).toEqual(
        failRootClose
          ? [
              `artifact reader for ${path}`,
              `root artifact descriptor for ${path}`,
            ]
          : [`artifact reader for ${path}`],
      );
      await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
      await resourceScope.close();
      expect(readerAttempts).toBe(3);
      expect(rootClose.attempts()).toBe(failRootClose ? 2 : 1);
      expect(resourceScope.hasPending).toBe(false);
    } finally {
      await resourceScope.close().catch(() => undefined);
      rootClose.restore();
      readerClose.mockRestore();
    }
  },
);

vi.mock("../pyinstaller/CArchiveLayout.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  observePyInstallerCookie: () =>
    Promise.reject(new ArtifactReaderFailure("format", "detection failed")),
}));

vi.mock("../../filesystem/RegularFile.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../filesystem/RegularFile.js")>();
  return { ...actual, openRegularFile: vi.fn(actual.openRegularFile) };
});

it("keeps the detection error primary and reports a failed detection close", async () => {
  const directory = await createTestTempDirectory("rea-extraction-detect-");
  const path = join(directory, "target.elf");
  await writeFile(path, Buffer.from("not an archive"));
  const resourceScope = new ArtifactResourceScope();
  const originalClose = OwnedFileHandle.prototype.close;
  const closeFailure = new Error("detection close failed");
  let attempts = 0;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      attempts += 1;
      if (attempts === 1) throw closeFailure;
      await originalClose.call(this);
    });
  try {
    await expect(
      extractArtifact({
        inputPath: path,
        inputFormat: "elf",
        outputRoot: join(directory, "out"),
        environment: process.env,
        integrityPolicy: "fail",
        resourceScope,
      }),
    ).rejects.toMatchObject({
      reason: "format",
      message: "detection failed",
      cleanup: { reason: closeFailure.message },
    });
    await resourceScope.close();
    expect(attempts).toBe(2);
  } finally {
    close.mockRestore();
    await resourceScope.close().catch(() => undefined);
  }
});

it("materializes the classified ASAR instead of repeating the adapter format hint", async () => {
  const directory = await createTestTempDirectory("rea-extraction-format-");
  const path = join(directory, "source.asar");
  const content = Buffer.from("observed member");
  await writeFile(
    path,
    Buffer.concat([
      asarHeaderBytes(
        JSON.stringify({
          files: { "member.txt": { size: content.length, offset: "0" } },
        }),
      ),
      content,
    ]),
  );
  const output = join(directory, "out");
  const resourceScope = new ArtifactResourceScope();
  try {
    const result = await extractArtifact(zipInput(path, output, resourceScope));
    expect(result.manifest.root_format).toBe("asar");
    expect(result.artifacts).toMatchObject([
      { relative_path: "member.txt", bytes_written: content.length },
    ]);
    expect((await readFile(join(output, "member.txt"))).equals(content)).toBe(
      true,
    );
  } finally {
    await resourceScope.close();
  }
});

it("plans dry-run extraction with unresolved/unsupported entries and labeled byte estimates without writing to disk", async () => {
  const directory = await createTestTempDirectory("rea-extraction-dry-run-");
  const source = join(directory, "source");
  await mkdir(join(source, "sub"), { recursive: true });
  await writeFile(join(source, "alpha.txt"), "alpha");
  await writeFile(join(source, "sub", "beta.txt"), "beta-bytes");
  await symlink("alpha.txt", join(source, "alias.txt"));
  const dryOutput = join(directory, "dry-out");
  const realOutput = join(directory, "real-out");
  const resourceScope = new ArtifactResourceScope();
  try {
    const planned = await extractArtifact({
      inputPath: source,
      inputFormat: "asar",
      outputRoot: dryOutput,
      dryRun: true,
      environment: {},
      integrityPolicy: "fail",
      resourceScope,
    });
    await expect(stat(dryOutput)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(directory)).toEqual(["source"]);
    expect(planned.dry_run).toBe(true);
    expect(planned.artifacts).toEqual([
      {
        artifact_id: expect.stringMatching(/^art_[a-f0-9]{64}$/u),
        relative_path: "alpha.txt",
        sha256: createHash("sha256").update("alpha").digest("hex"),
        bytes_written: 0,
        created: false,
      },
      {
        artifact_id: expect.stringMatching(/^art_[a-f0-9]{64}$/u),
        relative_path: "sub/beta.txt",
        sha256: createHash("sha256").update("beta-bytes").digest("hex"),
        bytes_written: 0,
        created: false,
      },
    ]);
    expect(planned.plan).toMatchObject({
      entries: [
        {
          logical_path: "alias.txt",
          entry_kind: "symlink",
          status: "unresolved",
          observed_bytes: null,
        },
        {
          logical_path: "alpha.txt",
          entry_kind: "file",
          status: "planned",
          reason: null,
          observed_bytes: 5,
          declared_bytes: 5,
        },
        {
          logical_path: "sub",
          entry_kind: "directory",
          status: "unsupported",
          observed_bytes: null,
        },
        {
          logical_path: "sub/beta.txt",
          entry_kind: "file",
          status: "planned",
          reason: null,
          observed_bytes: 10,
          declared_bytes: 10,
        },
      ],
      totals: {
        planned_files: 2,
        unsupported_entries: 1,
        unresolved_entries: 1,
        observed_bytes_estimate: 15,
        declared_bytes_estimate: 15,
        byte_totals_basis: "declared-and-observed-content-estimates",
      },
    });

    const materialized = await extractArtifact({
      inputPath: source,
      inputFormat: "asar",
      outputRoot: realOutput,
      environment: {},
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(materialized.dry_run).toBeUndefined();
    expect(materialized.plan).toBeUndefined();
    expect(
      planned.artifacts.map(({ artifact_id, relative_path, sha256 }) => ({
        artifact_id,
        relative_path,
        sha256,
      })),
    ).toEqual(
      materialized.artifacts.map(({ artifact_id, relative_path, sha256 }) => ({
        artifact_id,
        relative_path,
        sha256,
      })),
    );
    expect(planned.extraction_manifest.selected_occurrence_ids).toEqual(
      materialized.extraction_manifest.selected_occurrence_ids,
    );
    expect(planned.limitations).not.toContain(
      DRY_RUN_NON_FILE_RECONCILIATION_LIMITATION,
    );
  } finally {
    await resourceScope.close();
  }
});

it("reconciles non-file directory and symlink entries against the inventory snapshot in dry-run mode", async () => {
  const directory = await createTestTempDirectory(
    "rea-extraction-dry-run-non-file-reconcile-",
  );
  const source = join(directory, "source");
  await mkdir(join(source, "empty-dir"), { recursive: true });
  await writeFile(join(source, "alpha.txt"), "alpha");
  await symlink("alpha.txt", join(source, "alias.txt"));
  const resourceScope = new ArtifactResourceScope();
  try {
    const stablePlan = await extractArtifact({
      inputPath: source,
      inputFormat: "asar",
      outputRoot: join(directory, "stable-dry-out"),
      dryRun: true,
      environment: {},
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(stablePlan.limitations).not.toContain(
      DRY_RUN_NON_FILE_RECONCILIATION_LIMITATION,
    );

    const mutatedSource = join(directory, "mutated-source");
    await mkdir(join(mutatedSource, "empty-dir"), { recursive: true });
    await writeFile(join(mutatedSource, "alpha.txt"), "alpha");
    const originalClose = DirectoryArtifactReader.prototype.close;
    let inventoryClosed = false;
    const closeSpy = vi
      .spyOn(DirectoryArtifactReader.prototype, "close")
      .mockImplementation(async function (this: DirectoryArtifactReader) {
        await originalClose.call(this);
        if (inventoryClosed) return;
        inventoryClosed = true;
        await rm(join(mutatedSource, "empty-dir"), { recursive: true });
        await symlink("alpha.txt", join(mutatedSource, "empty-dir"));
      });
    try {
      const kindMismatchPlan = await extractArtifact({
        inputPath: mutatedSource,
        inputFormat: "asar",
        outputRoot: join(directory, "kind-mismatch-dry-out"),
        dryRun: true,
        environment: {},
        integrityPolicy: "fail",
        resourceScope,
      });
      expect(kindMismatchPlan.limitations).toContain(
        formatDryRunNonFileKindMismatchReason(
          "directory",
          "empty-dir",
          "symlink",
        ),
      );
      expect(kindMismatchPlan.limitations).toContain(
        DRY_RUN_NON_FILE_RECONCILIATION_LIMITATION,
      );
      expect(
        kindMismatchPlan.plan?.entries.find(
          ({ logical_path }) => logical_path === "empty-dir",
        ),
      ).toMatchObject({
        logical_path: "empty-dir",
        entry_kind: "directory",
        status: "unresolved",
        reason: formatDryRunNonFileKindMismatchReason(
          "directory",
          "empty-dir",
          "symlink",
        ),
      });
    } finally {
      closeSpy.mockRestore();
    }

    const addedDirSource = join(directory, "added-dir-source");
    await mkdir(addedDirSource, { recursive: true });
    await writeFile(join(addedDirSource, "alpha.txt"), "alpha");
    let addedInventoryClosed = false;
    const addedCloseSpy = vi
      .spyOn(DirectoryArtifactReader.prototype, "close")
      .mockImplementation(async function (this: DirectoryArtifactReader) {
        await originalClose.call(this);
        if (addedInventoryClosed) return;
        addedInventoryClosed = true;
        await mkdir(join(addedDirSource, "new-dir"), { recursive: true });
      });
    try {
      const addedDirPlan = await extractArtifact({
        inputPath: addedDirSource,
        inputFormat: "asar",
        outputRoot: join(directory, "added-dir-dry-out"),
        dryRun: true,
        environment: {},
        integrityPolicy: "fail",
        resourceScope,
      });
      expect(addedDirPlan.plan?.totals).toMatchObject({
        planned_files: 1,
        unresolved_entries: 0,
      });
      expect(addedDirPlan.limitations).toContain(
        formatDryRunNonFileAddedLimitation("directory", "new-dir"),
      );
      expect(addedDirPlan.limitations).toContain(
        DRY_RUN_NON_FILE_DRIFT_SUMMARY_LIMITATION,
      );
    } finally {
      addedCloseSpy.mockRestore();
    }
  } finally {
    await resourceScope.close();
  }
});

it("refuses a classified non-container before publishing extraction output", async () => {
  const directory = await createTestTempDirectory(
    "rea-extraction-unsupported-",
  );
  const path = join(directory, "source.zip");
  await writeFile(path, "ordinary file bytes");
  const output = join(directory, "out");
  const resourceScope = new ArtifactResourceScope();
  try {
    await expect(
      extractArtifact(zipInput(path, output, resourceScope)),
    ).rejects.toMatchObject({
      operation: "extract_artifact",
      message: expect.stringContaining(
        "Artifact format has no extraction reader: file",
      ),
    });
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await resourceScope.close();
  }
});

it("matches real extraction refusal on NFC path collisions and Windows invalid names in dry-run mode", async () => {
  const directory = await createTestTempDirectory(
    "rea-extraction-dry-run-collisions-",
  );
  const collisionZip = join(directory, "collision.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("cafe\u0301.txt", new TextReader("nfd"));
  await writer.add("caf\u00e9.txt", new TextReader("nfc"));
  await writeFile(collisionZip, Buffer.from(await writer.close()));

  const winInvalidZip = join(directory, "win-invalid.zip");
  const winWriter = new ZipWriter(new Uint8ArrayWriter());
  await winWriter.add("stream:data.txt", new TextReader("ads"));
  await writeFile(winInvalidZip, Buffer.from(await winWriter.close()));

  const resourceScope = new ArtifactResourceScope();
  try {
    const dryCollisionOut = join(directory, "dry-collision-out");
    const realCollisionOut = join(directory, "real-collision-out");
    const dryCollisionError = await extractArtifact({
      ...zipInput(collisionZip, dryCollisionOut, resourceScope),
      dryRun: true,
    }).catch((cause: unknown) => cause);
    const realCollisionError = await extractArtifact(
      zipInput(collisionZip, realCollisionOut, resourceScope),
    ).catch((cause: unknown) => cause);
    expect(dryCollisionError).toBeInstanceOf(ArtifactReaderFailure);
    expect(realCollisionError).toBeInstanceOf(ArtifactReaderFailure);
    expect((dryCollisionError as ArtifactReaderFailure).reason).toBe("path");
    expect((dryCollisionError as ArtifactReaderFailure).message).toBe(
      (realCollisionError as ArtifactReaderFailure).message,
    );
    await expect(stat(dryCollisionOut)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const dryWinOut = join(directory, "dry-win-out");
    const realWinOut = join(directory, "real-win-out");
    const dryWinError = await extractArtifact({
      ...zipInput(winInvalidZip, dryWinOut, resourceScope),
      dryRun: true,
      platform: "win32",
    }).catch((cause: unknown) => cause);
    const realWinError = await extractArtifact({
      ...zipInput(winInvalidZip, realWinOut, resourceScope),
      platform: "win32",
    }).catch((cause: unknown) => cause);
    expect(dryWinError).toBeInstanceOf(ArtifactReaderFailure);
    expect(realWinError).toBeInstanceOf(ArtifactReaderFailure);
    expect((dryWinError as ArtifactReaderFailure).reason).toBe("path");
    expect((dryWinError as ArtifactReaderFailure).message).toBe(
      (realWinError as ArtifactReaderFailure).message,
    );
    await expect(stat(dryWinOut)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(realWinOut)).rejects.toMatchObject({ code: "ENOENT" });

    for (const invalidName of [
      "bad?.txt",
      "wild*.txt",
      "angle<left.txt",
      "angle>right.txt",
      'quote"name.txt',
      "pipe|name.txt",
      "trailing-dot./file.txt",
      "trailing-space /file.txt",
      "CON.txt",
      "sub/lpt9",
    ]) {
      const zipPath = join(
        directory,
        `win-${Buffer.from(invalidName).toString("hex")}.zip`,
      );
      const invalidWriter = new ZipWriter(new Uint8ArrayWriter());
      await invalidWriter.add(invalidName, new TextReader("bad"));
      await writeFile(zipPath, Buffer.from(await invalidWriter.close()));
      const invalidDryOut = join(
        directory,
        `out-${Buffer.from(invalidName).toString("hex")}`,
      );
      const err = await extractArtifact({
        ...zipInput(zipPath, invalidDryOut, resourceScope),
        dryRun: true,
        platform: "win32",
      }).catch((cause: unknown) => cause);
      expect(err).toBeInstanceOf(ArtifactReaderFailure);
      expect((err as ArtifactReaderFailure).reason).toBe("path");
      await expect(stat(invalidDryOut)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  } finally {
    await resourceScope.close();
  }
});

it("refuses case-folding file and parent directory collisions in dry-run mode when the destination is case-insensitive", async () => {
  const directory = await createTestTempDirectory(
    "rea-extraction-dry-run-case-collision-",
  );
  const fileCaseZip = join(directory, "file-case.zip");
  const fileWriter = new ZipWriter(new Uint8ArrayWriter());
  await fileWriter.add("Foo.txt", new TextReader("upper"));
  await fileWriter.add("foo.txt", new TextReader("lower"));
  await writeFile(fileCaseZip, Buffer.from(await fileWriter.close()));

  const parentCaseZip = join(directory, "parent-case.zip");
  const parentWriter = new ZipWriter(new Uint8ArrayWriter());
  await parentWriter.add("Dir/a.txt", new TextReader("upper-dir"));
  await parentWriter.add("dir/b.txt", new TextReader("lower-dir"));
  await writeFile(parentCaseZip, Buffer.from(await parentWriter.close()));

  const resourceScope = new ArtifactResourceScope();
  const realCheckDestination =
    SafeOutputTree.checkDestination.bind(SafeOutputTree);
  const checkDestinationSpy = vi
    .spyOn(SafeOutputTree, "checkDestination")
    .mockImplementation(async (outputRoot: string) => {
      const checked = await realCheckDestination(outputRoot);
      return { ...checked, caseSensitivity: "case-insensitive" };
    });
  try {
    const fileOut = join(directory, "file-case-out");
    const fileError = await extractArtifact({
      ...zipInput(fileCaseZip, fileOut, resourceScope),
      dryRun: true,
      platform: "win32",
    }).catch((cause: unknown) => cause);
    expect(fileError).toBeInstanceOf(DestinationCaseCollisionFailure);
    expect((fileError as DestinationCaseCollisionFailure).reason).toBe("path");
    expect((fileError as DestinationCaseCollisionFailure).message).toBe(
      "Destination filesystem cannot store both foo.txt and Foo.txt; inventory retains both logical names.",
    );
    await expect(stat(fileOut)).rejects.toMatchObject({ code: "ENOENT" });

    const parentOut = join(directory, "parent-case-out");
    const parentError = await extractArtifact({
      ...zipInput(parentCaseZip, parentOut, resourceScope),
      dryRun: true,
      platform: "win32",
    }).catch((cause: unknown) => cause);
    expect(parentError).toBeInstanceOf(DestinationCaseCollisionFailure);
    expect((parentError as DestinationCaseCollisionFailure).reason).toBe(
      "path",
    );
    expect((parentError as DestinationCaseCollisionFailure).message).toBe(
      "Destination filesystem cannot store both dir and Dir; inventory retains both logical names.",
    );
    await expect(stat(parentOut)).rejects.toMatchObject({ code: "ENOENT" });

    const nonAsciiZip = join(directory, "non-ascii-case.zip");
    const nonAsciiWriter = new ZipWriter(new Uint8ArrayWriter());
    await nonAsciiWriter.add("σ.txt", new TextReader("medial"));
    await nonAsciiWriter.add("ς.txt", new TextReader("final"));
    await nonAsciiWriter.add("𐐀.txt", new TextReader("deseret-upper"));
    await nonAsciiWriter.add("𐐨.txt", new TextReader("deseret-lower"));
    await nonAsciiWriter.add("straße.txt", new TextReader("sharp-s"));
    await nonAsciiWriter.add("strasse.txt", new TextReader("double-s"));
    await writeFile(nonAsciiZip, Buffer.from(await nonAsciiWriter.close()));
    const nonAsciiOut = join(directory, "non-ascii-case-out");
    const nonAsciiPlan = await extractArtifact({
      ...zipInput(nonAsciiZip, nonAsciiOut, resourceScope),
      dryRun: true,
      platform: "win32",
    });
    expect(nonAsciiPlan.artifacts).toEqual([]);
    expect(nonAsciiPlan.plan?.totals).toMatchObject({
      planned_files: 0,
      unresolved_entries: 6,
      observed_bytes_estimate: 0,
    });
    expect(
      nonAsciiPlan.plan?.entries.map(({ logical_path, status }) => ({
        logical_path,
        status,
      })),
    ).toEqual([
      { logical_path: "strasse.txt", status: "unresolved" },
      { logical_path: "straße.txt", status: "unresolved" },
      { logical_path: "ς.txt", status: "unresolved" },
      { logical_path: "σ.txt", status: "unresolved" },
      { logical_path: "𐐀.txt", status: "unresolved" },
      { logical_path: "𐐨.txt", status: "unresolved" },
    ]);
    expect(nonAsciiPlan.limitations).toContain(DRY_RUN_UNRESOLVED_LIMITATION);
    expect(nonAsciiPlan.limitations).toContain(
      DRY_RUN_NON_ASCII_CASE_LIMITATION,
    );
    await expect(stat(nonAsciiOut)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    checkDestinationSpy.mockRestore();
    await resourceScope.close();
  }
});

it("observes destination directory case sensitivity with bounded scans and hard-link disambiguation", async () => {
  const directory = await createTestTempDirectory(
    "rea-extraction-dry-run-case-observation-",
  );
  const fileCaseZip = join(directory, "file-case.zip");
  const fileWriter = new ZipWriter(new Uint8ArrayWriter());
  await fileWriter.add("Foo.txt", new TextReader("upper"));
  await fileWriter.add("foo.txt", new TextReader("lower"));
  await writeFile(fileCaseZip, Buffer.from(await fileWriter.close()));

  const resourceScope = new ArtifactResourceScope();
  try {
    const hardlinkParent = join(directory, "hardlink-parent");
    await mkdir(hardlinkParent, { recursive: true });
    await writeFile(join(hardlinkParent, "Foo"), "same-inode");
    const supportsDistinctCaseSpellings = !(await stat(
      join(hardlinkParent, "foo"),
    ).then(
      () => true,
      () => false,
    ));
    if (supportsDistinctCaseSpellings) {
      const winCaseSensitiveOut = join(directory, "win-case-sensitive-out");
      const winCaseSensitivePlan = await extractArtifact({
        ...zipInput(fileCaseZip, winCaseSensitiveOut, resourceScope),
        dryRun: true,
        platform: "win32",
      });
      expect(winCaseSensitivePlan.plan?.totals).toMatchObject({
        planned_files: 2,
        unresolved_entries: 0,
      });
      await expect(stat(winCaseSensitiveOut)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    if (process.platform !== "win32" && supportsDistinctCaseSpellings) {
      await link(join(hardlinkParent, "Foo"), join(hardlinkParent, "foo"));
      const hardlinkOut = join(hardlinkParent, "out");
      const hardlinkPlan = await extractArtifact({
        ...zipInput(fileCaseZip, hardlinkOut, resourceScope),
        dryRun: true,
        platform: "linux",
      });
      expect(hardlinkPlan.plan?.totals).toMatchObject({
        planned_files: 2,
        unresolved_entries: 0,
      });
      expect(
        hardlinkPlan.plan?.entries.map(({ logical_path, status }) => ({
          logical_path,
          status,
        })),
      ).toEqual([
        { logical_path: "Foo.txt", status: "planned" },
        { logical_path: "foo.txt", status: "planned" },
      ]);
      await expect(stat(hardlinkOut)).rejects.toMatchObject({ code: "ENOENT" });
    }

    const crowdedParent = join(directory, "crowded-parent");
    await mkdir(crowdedParent, { recursive: true });
    await Promise.all(
      Array.from({ length: 257 }, (_, index) =>
        writeFile(join(crowdedParent, String(index)), ""),
      ),
    );
    const crowdedOut = join(crowdedParent, "out");
    const crowdedPlan = await extractArtifact({
      ...zipInput(fileCaseZip, crowdedOut, resourceScope),
      dryRun: true,
      platform: "linux",
    });
    expect(crowdedPlan.plan?.totals).toMatchObject({
      planned_files: 0,
      unresolved_entries: 2,
      observed_bytes_estimate: 0,
    });
    await expect(stat(crowdedOut)).rejects.toMatchObject({ code: "ENOENT" });

    const emptyMount = join(directory, "empty-mount");
    await mkdir(emptyMount, { recursive: true });
    const unknownOut = join(emptyMount, "out");
    const unknownPlan = await extractArtifact({
      ...zipInput(fileCaseZip, unknownOut, resourceScope),
      dryRun: true,
      platform: "linux",
    });
    expect(unknownPlan.artifacts).toEqual([]);
    expect(unknownPlan.plan?.totals).toMatchObject({
      planned_files: 0,
      unresolved_entries: 2,
      observed_bytes_estimate: 0,
    });
    expect(
      unknownPlan.plan?.entries.map(({ logical_path, status }) => ({
        logical_path,
        status,
      })),
    ).toEqual([
      { logical_path: "Foo.txt", status: "unresolved" },
      { logical_path: "foo.txt", status: "unresolved" },
    ]);
    expect(unknownPlan.limitations).toContain(DRY_RUN_UNRESOLVED_LIMITATION);
    expect(unknownPlan.limitations).toContain(DRY_RUN_UNKNOWN_CASE_LIMITATION);
    await expect(stat(unknownOut)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await resourceScope.close();
  }
});

it("observes cancellation that arrives while closing a non-ZIP reader in dry-run mode", async () => {
  const directory = await createTestTempDirectory(
    "rea-extraction-dry-run-cancel-close-",
  );
  const source = join(directory, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "alpha.txt"), "alpha");
  const controller = new AbortController();
  const reason = new Error("cancel during directory reader close");
  const originalClose = DirectoryArtifactReader.prototype.close;
  let extractionCleanupCall = false;
  const closeSpy = vi
    .spyOn(DirectoryArtifactReader.prototype, "close")
    .mockImplementation(async function (this: DirectoryArtifactReader) {
      if (extractionCleanupCall) controller.abort(reason);
      extractionCleanupCall = true;
      await originalClose.call(this);
    });
  const resourceScope = new ArtifactResourceScope();
  try {
    await expect(
      extractArtifact(
        {
          inputPath: source,
          inputFormat: "asar",
          outputRoot: join(directory, "dry-out"),
          dryRun: true,
          environment: {},
          integrityPolicy: "fail",
          resourceScope,
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({
      reason: "cancelled",
      cause: reason,
    });
  } finally {
    closeSpy.mockRestore();
    await resourceScope.close();
  }
});

it("retains observed_bytes on unsupported nested ASAR members without adding them to planned byte totals", async () => {
  const directory = await createTestTempDirectory(
    "rea-extraction-dry-run-nested-asar-",
  );
  const source = join(directory, "application");
  await mkdir(join(source, "resources"), { recursive: true });
  const nestedPayload = Buffer.from("nested-main-payload");
  const nestedAsar = Buffer.concat([
    asarHeaderBytes(
      JSON.stringify({
        files: {
          subdir: {
            files: {
              "main.js": {
                size: nestedPayload.byteLength,
                offset: "0",
              },
            },
          },
        },
      }),
    ),
    nestedPayload,
  ]);
  await writeFile(join(source, "resources", "app.asar"), nestedAsar);
  const resourceScope = new ArtifactResourceScope();
  try {
    const planned = await extractArtifact({
      inputPath: source,
      inputFormat: "asar",
      outputRoot: join(directory, "dry-out"),
      dryRun: true,
      environment: {},
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(planned.plan).toBeDefined();
    const containerEntry = planned.plan?.entries.find(
      ({ logical_path }) => logical_path === "resources/app.asar",
    );
    const nestedMemberEntry = planned.plan?.entries.find(
      ({ logical_path }) =>
        logical_path === "resources/app.asar/subdir/main.js",
    );
    expect(containerEntry).toMatchObject({
      logical_path: "resources/app.asar",
      entry_kind: "file",
      status: "planned",
      observed_bytes: nestedAsar.byteLength,
      declared_bytes: nestedAsar.byteLength,
    });
    expect(nestedMemberEntry).toMatchObject({
      logical_path: "resources/app.asar/subdir/main.js",
      entry_kind: "file",
      status: "unsupported",
      observed_bytes: nestedPayload.byteLength,
      declared_bytes: nestedPayload.byteLength,
    });
    expect(planned.plan?.totals).toMatchObject({
      planned_files: 1,
      unsupported_entries: 3,
      unresolved_entries: 0,
      observed_bytes_estimate: nestedAsar.byteLength,
      declared_bytes_estimate: nestedAsar.byteLength,
    });
    expect(planned.limitations).not.toContain(
      DRY_RUN_NON_FILE_RECONCILIATION_LIMITATION,
    );
  } finally {
    await resourceScope.close();
  }
});

it("rejects directory source content modified between inventory and dry-run planning", async () => {
  const directory = await createTestTempDirectory(
    "rea-extraction-dry-run-dir-freshness-",
  );
  const source = join(directory, "source");
  await mkdir(source, { recursive: true });
  const targetFile = join(source, "alpha.txt");
  await writeFile(targetFile, "alpha-v1");
  const originalClose = DirectoryArtifactReader.prototype.close;
  let inventoryClosed = false;
  const closeSpy = vi
    .spyOn(DirectoryArtifactReader.prototype, "close")
    .mockImplementation(async function (this: DirectoryArtifactReader) {
      await originalClose.call(this);
      if (!inventoryClosed) {
        inventoryClosed = true;
        await writeFile(targetFile, "alpha-v2");
      }
    });
  const resourceScope = new ArtifactResourceScope();
  try {
    await expect(
      extractArtifact({
        inputPath: source,
        inputFormat: "asar",
        outputRoot: join(directory, "dry-out"),
        dryRun: true,
        environment: {},
        integrityPolicy: "fail",
        resourceScope,
      }),
    ).rejects.toMatchObject({
      reason: "integrity",
      message: "Extracted content disagrees with inventory: alpha.txt",
    });
  } finally {
    closeSpy.mockRestore();
    await resourceScope.close();
  }
});

it("classifies over-limit destination path segments and resolved symlink paths as unresolved in dry-run plans", async () => {
  const directory = await createTestTempDirectory(
    "rea-extraction-dry-run-over-limit-segment-",
  );
  const archive = join(directory, "over-limit.zip");
  const overLimitName = `${"a".repeat(256)}.txt`;
  const overLimitNestedPath = Array.from(
    { length: 5 },
    (_, index) => `${String(index)}-${"b".repeat(210)}`,
  ).join("/");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(overLimitName, new TextReader("payload"));
  await writer.add(overLimitNestedPath, new TextReader("nested"));
  await writer.add("short.txt", new TextReader("ok"));
  await writeFile(archive, Buffer.from(await writer.close()));
  const resourceScope = new ArtifactResourceScope();
  try {
    const outputRoot = join(directory, "dry-out");
    const planned = await extractArtifact({
      ...zipInput(archive, outputRoot, resourceScope),
      dryRun: true,
    });
    expect(planned.artifacts).toEqual([
      expect.objectContaining({
        relative_path: "short.txt",
        bytes_written: 0,
        created: false,
      }),
    ]);
    expect(planned.plan?.totals).toMatchObject({
      planned_files: 1,
      unsupported_entries: 0,
      unresolved_entries: 2,
      observed_bytes_estimate: 2,
      declared_bytes_estimate: 2,
    });
    expect(
      planned.plan?.entries.map(({ logical_path, status }) => ({
        logical_path,
        status,
      })),
    ).toEqual([
      { logical_path: overLimitNestedPath, status: "unresolved" },
      { logical_path: overLimitName, status: "unresolved" },
      { logical_path: "short.txt", status: "planned" },
    ]);
    expect(planned.limitations).toContain(DRY_RUN_UNRESOLVED_LIMITATION);
    expect(planned.limitations).toContain(DRY_RUN_OVER_LIMIT_LIMITATION);
    await expect(stat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });

    if (process.platform !== "win32") {
      const longParent = join(
        directory,
        ...Array.from(
          { length: 4 },
          (_, index) => `real-${String(index)}-${"d".repeat(180)}`,
        ),
      );
      await mkdir(longParent, { recursive: true });
      const shortSymlinkParent = join(directory, "s");
      await symlink(longParent, shortSymlinkParent);
      const symlinkArchive = join(directory, "symlink-length.zip");
      const borderlineEntry = `${"e".repeat(200)}/${"f".repeat(150)}.txt`;
      const symlinkWriter = new ZipWriter(new Uint8ArrayWriter());
      await symlinkWriter.add(borderlineEntry, new TextReader("deep"));
      await writeFile(symlinkArchive, Buffer.from(await symlinkWriter.close()));
      const symlinkOutputRoot = join(shortSymlinkParent, "out");
      const symlinkPlan = await extractArtifact({
        ...zipInput(symlinkArchive, symlinkOutputRoot, resourceScope),
        dryRun: true,
      });
      expect(symlinkPlan.plan?.entries).toEqual([
        expect.objectContaining({
          logical_path: borderlineEntry,
          status: "unresolved",
        }),
      ]);
      await expect(stat(symlinkOutputRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  } finally {
    await resourceScope.close();
  }
});

it("retains ownership and surfaces an owned cleanup failure when the case-probe directory close fails", async () => {
  const directory = await createTestTempDirectory(
    "rea-extraction-dry-run-case-probe-close-",
  );
  const archive = join(directory, "archive.zip");
  await writeFile(archive, await zipBytes("alpha"));
  const parentDir = join(directory, "parent");
  await mkdir(parentDir, { recursive: true });
  await writeFile(join(parentDir, "ProbeFile"), "probe");
  const closeFailure = new Error("case-probe directory close failed");
  const closeSpy = vi
    .spyOn(OwnedDirectoryHandle.prototype, "close")
    .mockRejectedValueOnce(closeFailure);
  const resourceScope = new ArtifactResourceScope();
  try {
    const error = await extractArtifact({
      ...zipInput(archive, join(parentDir, "dry-out"), resourceScope),
      dryRun: true,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ArtifactReaderFailure);
    expect((error as ArtifactReaderFailure).cleanup).toEqual({
      reason: "case-probe directory close failed",
      resources: [expect.stringContaining("parent")],
    });
    expect((error as ArtifactReaderFailure).cleanupLeases).toHaveLength(1);
    expect(resourceScope.hasPending).toBe(true);
    expect(resourceScope.cleanupResources).toEqual([
      expect.stringContaining("parent"),
    ]);
  } finally {
    closeSpy.mockRestore();
    await resourceScope.close().catch(() => undefined);
  }
});

it("revalidates unpacked ASAR companion files during dry-run planning", async () => {
  const directory = await createTestTempDirectory(
    "rea-extraction-dry-run-asar-unpacked-",
  );
  const archivePath = join(directory, "app.asar");
  const unpackedDir = `${archivePath}.unpacked`;
  await mkdir(unpackedDir, { recursive: true });
  const packedPayload = Buffer.from("packed-main-payload");
  const unpackedPayload = Buffer.from("unpacked-native-payload-v1");
  const unpackedPath = join(unpackedDir, "native.node");
  await writeFile(unpackedPath, unpackedPayload);
  const asarArchive = Buffer.concat([
    asarHeaderBytes(
      JSON.stringify({
        files: {
          "main.js": {
            size: packedPayload.byteLength,
            offset: "0",
          },
          "native.node": {
            size: unpackedPayload.byteLength,
            unpacked: true,
          },
        },
      }),
    ),
    packedPayload,
  ]);
  await writeFile(archivePath, asarArchive);

  const resourceScope = new ArtifactResourceScope();
  try {
    const validOut = join(directory, "valid-dry-out");
    const validPlan = await extractArtifact({
      inputPath: archivePath,
      inputFormat: "asar",
      outputRoot: validOut,
      dryRun: true,
      environment: {},
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(validPlan.limitations).toContain(DRY_RUN_VALIDATED_LIMITATION);
    expect(validPlan.plan?.totals).toMatchObject({
      planned_files: 2,
      unresolved_entries: 0,
      observed_bytes_estimate:
        packedPayload.byteLength + unpackedPayload.byteLength,
      declared_bytes_estimate:
        packedPayload.byteLength + unpackedPayload.byteLength,
    });
    await expect(stat(validOut)).rejects.toMatchObject({ code: "ENOENT" });

    const originalClose = AsarArtifactReader.prototype.close;
    let mutateOnInventoryClose: "modify" | "remove" | undefined = "modify";
    const closeSpy = vi
      .spyOn(AsarArtifactReader.prototype, "close")
      .mockImplementation(async function (this: AsarArtifactReader) {
        await originalClose.call(this);
        if (mutateOnInventoryClose === "modify") {
          mutateOnInventoryClose = undefined;
          await writeFile(unpackedPath, "unpacked-native-payload-v2");
        } else if (mutateOnInventoryClose === "remove") {
          mutateOnInventoryClose = undefined;
          await rm(unpackedPath, { force: true });
        }
      });
    try {
      await expect(
        extractArtifact({
          inputPath: archivePath,
          inputFormat: "asar",
          outputRoot: join(directory, "modified-dry-out"),
          dryRun: true,
          environment: {},
          integrityPolicy: "fail",
          resourceScope,
        }),
      ).rejects.toMatchObject({
        reason: "integrity",
        message: "Extracted content disagrees with inventory: native.node",
      });

      await writeFile(unpackedPath, unpackedPayload);
      mutateOnInventoryClose = "remove";
      await expect(
        extractArtifact({
          inputPath: archivePath,
          inputFormat: "asar",
          outputRoot: join(directory, "removed-dry-out"),
          dryRun: true,
          environment: {},
          integrityPolicy: "fail",
          resourceScope,
        }),
      ).rejects.toMatchObject({
        reason: "unavailable",
        message: "ASAR unpacked entry bytes are unavailable: native.node",
      });
    } finally {
      closeSpy.mockRestore();
    }
    const mismatchArchive = join(directory, "mismatch.asar");
    const overLimitEntryName = `${"m".repeat(256)}.js`;
    const mismatchPayload = Buffer.from("mismatch-payload");
    const mismatchAsar = Buffer.concat([
      asarHeaderBytes(
        JSON.stringify({
          files: {
            [overLimitEntryName]: {
              size: mismatchPayload.byteLength,
              offset: "0",
              integrity: {
                algorithm: "SHA256",
                hash: "0".repeat(64),
                blockSize: 4194304,
                blocks: ["0".repeat(64)],
              },
            },
          },
        }),
      ),
      mismatchPayload,
    ]);
    await writeFile(mismatchArchive, mismatchAsar);
    const mismatchPlan = await extractArtifact({
      inputPath: mismatchArchive,
      inputFormat: "asar",
      outputRoot: join(directory, "mismatch-dry-out"),
      dryRun: true,
      environment: {},
      integrityPolicy: "record-and-continue",
      resourceScope,
    });
    expect(mismatchPlan.plan?.totals).toMatchObject({
      planned_files: 0,
      unresolved_entries: 1,
    });
    expect(mismatchPlan.limitations).toContain(
      formatExtractionIntegrityContradictionLimitation(1, true),
    );
  } finally {
    await resourceScope.close();
  }
});

it("rejects unpaired UTF-16 surrogates in archive entries and output roots and marks short destination component limits unresolved", async () => {
  const directory = await createTestTempDirectory("rea-extract-surrogate-");
  const resourceScope = new ArtifactResourceScope();
  try {
    const payload = Buffer.from("surrogate-payload");
    const digest = createHash("sha256").update(payload).digest("hex");
    const surrogateAsar = Buffer.concat([
      asarHeaderBytes(
        `{"files":{"\\ud800.txt":{"size":${String(payload.byteLength)},"offset":"0","integrity":{"algorithm":"SHA256","hash":"${digest}","blockSize":4194304,"blocks":["${digest}"]}},"\\ud801.txt":{"size":${String(payload.byteLength)},"offset":"0","integrity":{"algorithm":"SHA256","hash":"${digest}","blockSize":4194304,"blocks":["${digest}"]}}}}`,
      ),
      payload,
    ]);
    const surrogateArchive = join(directory, "surrogate.asar");
    await writeFile(surrogateArchive, surrogateAsar);

    for (const dryRun of [true, false]) {
      const outputRoot = join(directory, `surrogate-out-${String(dryRun)}`);
      await expect(
        extractArtifact({
          inputPath: surrogateArchive,
          inputFormat: "asar",
          outputRoot,
          dryRun,
          environment: {},
          integrityPolicy: "fail",
          resourceScope,
        }),
      ).rejects.toMatchObject({
        reason: "path",
        message: expect.stringMatching(/unpaired UTF-16 surrogates/),
      });
      await expect(stat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
    }

    const illFormedRoot = join(directory, "bad-\ud800-root");
    await expect(
      SafeOutputTree.checkDestination(illFormedRoot, { resourceScope }),
    ).rejects.toThrow(/unpaired UTF-16 surrogates/);

    const shortLimitSegment = `${"e".repeat(176)}.txt`;
    const shortLimitArchive = join(directory, "short-limit.zip");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add(shortLimitSegment, new TextReader("ecryptfs-probe"));
    await writeFile(shortLimitArchive, Buffer.from(await writer.close()));

    lstatOverride = (targetPath: string) => {
      if (targetPath === join(directory, shortLimitSegment))
        return Promise.reject(
          Object.assign(new Error("ENAMETOOLONG: file name too long"), {
            code: "ENAMETOOLONG",
          }),
        );
      return undefined;
    };
    try {
      const dryRunResult = await extractArtifact({
        inputPath: shortLimitArchive,
        inputFormat: "zip",
        outputRoot: join(directory, "short-limit-out"),
        dryRun: true,
        environment: {},
        integrityPolicy: "fail",
        resourceScope,
      });
      expect(dryRunResult.plan?.totals).toMatchObject({
        planned_files: 0,
        unresolved_entries: 1,
      });
      expect(dryRunResult.plan?.entries[0]).toMatchObject({
        logical_path: shortLimitSegment,
        status: "unresolved",
        reason: expect.stringMatching(/ENAMETOOLONG/),
      });
    } finally {
      lstatOverride = undefined;
    }
  } finally {
    await resourceScope.close();
  }
});

it("revalidates transferred ZIP member and container bytes during dry-run, bounds component-limit probes across distinct names, and pages large dry-run plans", async () => {
  const directory = await createTestTempDirectory("rea-extract-codex-p2-");
  const resourceScope = new ArtifactResourceScope();
  try {
    // 1. Transferred ZIP rewritten in-place with identical size and restored mtime/ctime after inventory
    const zipPath = join(directory, "rewritten-in-place.zip");
    const writer1 = new ZipWriter(new Uint8ArrayWriter());
    await writer1.add("payload.txt", new TextReader("AAAA-original-bytes"));
    const zipBytes1 = Buffer.from(await writer1.close());

    const writer2 = new ZipWriter(new Uint8ArrayWriter());
    await writer2.add("payload.txt", new TextReader("BBBB-modified-bytes"));
    const zipBytes2 = Buffer.from(await writer2.close());
    expect(zipBytes2.byteLength).toBe(zipBytes1.byteLength);
    await writeFile(zipPath, zipBytes1);

    const originalZipClose = ZipArtifactReader.prototype.close;
    let closeCount = 0;
    const closeSpy = vi
      .spyOn(ZipArtifactReader.prototype, "close")
      .mockImplementation(async function (this: ZipArtifactReader) {
        await originalZipClose.call(this);
        closeCount += 1;
        if (closeCount === 1) {
          const handle = await open(zipPath, "r+");
          try {
            const before = await handle.stat();
            await handle.write(zipBytes2, 0, zipBytes2.byteLength, 0);
            await handle.utimes(before.atime, before.mtime);
          } finally {
            await handle.close();
          }
        }
      });
    try {
      await expect(
        extractArtifact({
          inputPath: zipPath,
          inputFormat: "zip",
          outputRoot: join(directory, "rewritten-zip-dry-out"),
          dryRun: true,
          environment: {},
          integrityPolicy: "fail",
          resourceScope,
        }),
      ).rejects.toMatchObject({
        reason: "integrity",
      });
    } finally {
      closeSpy.mockRestore();
    }

    // 2. Bounded component-limit probes across many distinct 140..220-byte names + dry-run plan paging
    const manyNamesArchive = join(directory, "many-names.zip");
    const manyWriter = new ZipWriter(new Uint8ArrayWriter());
    for (let index = 0; index < 40; index += 1) {
      const padLen = 140 + (index % 20);
      const name = `entry-${String(index).padStart(4, "0")}-${"x".repeat(padLen)}.txt`;
      await manyWriter.add(name, new TextReader(`item-${String(index)}`));
    }
    await writeFile(manyNamesArchive, Buffer.from(await manyWriter.close()));

    let destinationProbeCount = 0;
    const pagedOutputRoot = join(directory, "paged-dry-out");
    const probePrefix = join(directory, "entry-");
    lstatOverride = (targetPath: string) => {
      if (targetPath.startsWith(probePrefix)) {
        destinationProbeCount += 1;
      }
      return undefined;
    };
    try {
      const page1 = await extractArtifact({
        inputPath: manyNamesArchive,
        inputFormat: "zip",
        outputRoot: pagedOutputRoot,
        dryRun: true,
        planOffset: 0,
        planLimit: 15,
        environment: {},
        integrityPolicy: "fail",
        resourceScope,
      });
      expect(destinationProbeCount).toBeGreaterThan(0);
      expect(destinationProbeCount).toBeLessThanOrEqual(2);
      expect(page1.plan?.page).toEqual({
        total_entries: 40,
        offset: 0,
        limit: 15,
        returned_entries: 15,
        next_offset: 15,
        truncated: true,
      });
      expect(page1.plan?.entries).toHaveLength(15);
      expect(page1.artifacts).toHaveLength(15);
      expect(page1.plan?.totals).toMatchObject({
        planned_files: 40,
        unsupported_entries: 0,
        unresolved_entries: 0,
      });
      expect(page1.limitations).toContain(
        formatDryRunPlanPageLimitation(15, 40, 0, 15),
      );

      const page3 = await extractArtifact({
        inputPath: manyNamesArchive,
        inputFormat: "zip",
        outputRoot: pagedOutputRoot,
        dryRun: true,
        planOffset: 30,
        planLimit: 15,
        environment: {},
        integrityPolicy: "fail",
        resourceScope,
      });
      expect(page3.plan?.page).toEqual({
        total_entries: 40,
        offset: 30,
        limit: 15,
        returned_entries: 10,
        next_offset: null,
        truncated: true,
      });
      expect(page3.plan?.entries).toHaveLength(10);
      expect(page3.artifacts).toHaveLength(10);
      expect(page3.extraction_manifest.extraction_id).toBe(
        page1.extraction_manifest.extraction_id,
      );
      expect(page3.limitations).toContain(
        formatDryRunPlanPageLimitation(10, 40, 30, null),
      );
      expect(page3.extraction_manifest.selected_occurrence_ids).toHaveLength(
        10,
      );
    } finally {
      lstatOverride = undefined;
    }
  } finally {
    await resourceScope.close();
  }
});

it("reuses validated dry-run plans across continuation pages, invalidates on mutation, and bounds oversized entries and ASAR diagnostics within MAX_DRY_RUN_PLAN_PAGE_BYTES", async () => {
  const directory = await createTestTempDirectory("rea-dry-run-page-budget-");
  const manyNamesArchive = join(directory, "many-names.zip");
  const manyWriter = new ZipWriter(new Uint8ArrayWriter());
  for (let index = 0; index < 40; index += 1) {
    const name = `entry-${String(index).padStart(4, "0")}.txt`;
    await manyWriter.add(name, new TextReader(`item-${String(index)}`));
  }
  await writeFile(manyNamesArchive, Buffer.from(await manyWriter.close()));
  const pagedOutputRoot = join(directory, "paged-dry-out");
  const resourceScope = new ArtifactResourceScope();
  try {
    await extractArtifact({
      inputPath: manyNamesArchive,
      inputFormat: "zip",
      outputRoot: pagedOutputRoot,
      dryRun: true,
      planOffset: 0,
      planLimit: 15,
      environment: {},
      integrityPolicy: "fail",
      resourceScope,
    });

    // 1. Continuation pages reuse the validated dry-run plan without re-hashing archive entries
    const zipReadSpy = vi.spyOn(ZipArtifactReader.prototype, "entries");
    try {
      const cachedPage2 = await extractArtifact({
        inputPath: manyNamesArchive,
        inputFormat: "zip",
        outputRoot: pagedOutputRoot,
        dryRun: true,
        planOffset: 15,
        planLimit: 15,
        environment: {},
        integrityPolicy: "fail",
        resourceScope,
      });
      expect(zipReadSpy).not.toHaveBeenCalled();
      expect(cachedPage2.plan?.page).toEqual({
        total_entries: 40,
        offset: 15,
        limit: 15,
        returned_entries: 15,
        next_offset: 30,
        truncated: true,
      });
    } finally {
      zipReadSpy.mockRestore();
    }

    // 2. Mutating the source archive before a continuation page fails closed with an integrity error
    await writeFile(manyNamesArchive, await zipBytes("mutated\n"));
    await expect(
      extractArtifact({
        inputPath: manyNamesArchive,
        inputFormat: "zip",
        outputRoot: pagedOutputRoot,
        dryRun: true,
        planOffset: 15,
        planLimit: 15,
        environment: {},
        integrityPolicy: "fail",
        resourceScope,
      }),
    ).rejects.toMatchObject({
      name: "ArtifactReaderFailure",
      reason: "integrity",
    });

    // 3. Byte-budgeted paging: 12 entries with ~50 KB paths stay strictly within MAX_DRY_RUN_PLAN_PAGE_BYTES
    const longNamesArchive = join(directory, "long-names-budget.zip");
    const longWriter = new ZipWriter(new Uint8ArrayWriter());
    for (let idx = 0; idx < 12; idx += 1) {
      const prefix = `${"a".repeat(250)}/`.repeat(200);
      await longWriter.add(
        `${prefix}item-${String(idx).padStart(2, "0")}.txt`,
        new TextReader(""),
      );
    }
    await writeFile(longNamesArchive, Buffer.from(await longWriter.close()));
    const longPage1 = await extractArtifact({
      inputPath: longNamesArchive,
      inputFormat: "zip",
      outputRoot: join(directory, "long-names-dry-out"),
      dryRun: true,
      environment: {},
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(longPage1.plan?.page?.truncated).toBe(true);
    expect(longPage1.plan?.page?.returned_entries).toBeGreaterThanOrEqual(1);
    expect(longPage1.plan?.page?.returned_entries).toBeLessThan(12);
    expect(longPage1.plan?.page?.next_offset).toBe(
      longPage1.plan?.page?.returned_entries,
    );
    expect(
      Buffer.byteLength(JSON.stringify(longPage1), "utf8"),
    ).toBeLessThanOrEqual(MAX_DRY_RUN_PLAN_PAGE_BYTES);
  } finally {
    await resourceScope.close();
  }
});

it("skips an oversized first dry-run entry with a bounded limitation and truncates oversized ASAR integrity diagnostics within MAX_DRY_RUN_PLAN_PAGE_BYTES", async () => {
  const directory = await createTestTempDirectory("rea-dry-run-oversized-");
  const resourceScope = new ArtifactResourceScope();
  try {
    // 1. Oversized first entry (multi-hundred-KB basename) exceeding MAX_DRY_RUN_PLAN_PAGE_BYTES is skipped with a bounded limitation and advances next_offset
    const oversizedArchive = join(directory, "oversized-first-entry.asar");
    const smallContent = Buffer.from("ok\n");
    const oversizedBasename = `a-${"x".repeat(550 * 1024)}.txt`;
    await writeFile(
      oversizedArchive,
      Buffer.concat([
        asarHeaderBytes(
          JSON.stringify({
            files: {
              [oversizedBasename]: {
                size: 0,
                offset: "0",
              },
              "z-small.txt": {
                size: smallContent.length,
                offset: "0",
              },
            },
          }),
        ),
        smallContent,
      ]),
    );
    const oversizedPage1 = await extractArtifact({
      inputPath: oversizedArchive,
      inputFormat: "asar",
      outputRoot: join(directory, "oversized-dry-out"),
      dryRun: true,
      planOffset: 0,
      planLimit: 10,
      environment: {},
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(oversizedPage1.plan?.page).toEqual({
      total_entries: 2,
      offset: 0,
      limit: 10,
      returned_entries: 0,
      next_offset: 1,
      truncated: true,
    });
    expect(oversizedPage1.plan?.entries).toEqual([]);
    expect(oversizedPage1.artifacts).toEqual([]);
    expect(
      oversizedPage1.limitations.some((item) =>
        item.startsWith("Skipped dry-run plan entry at offset 0 ("),
      ),
    ).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(oversizedPage1), "utf8"),
    ).toBeLessThanOrEqual(MAX_DRY_RUN_PLAN_PAGE_BYTES);

    const oversizedPage2 = await extractArtifact({
      inputPath: oversizedArchive,
      inputFormat: "asar",
      outputRoot: join(directory, "oversized-dry-out"),
      dryRun: true,
      planOffset: 1,
      planLimit: 10,
      environment: {},
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(oversizedPage2.plan?.page).toEqual({
      total_entries: 2,
      offset: 1,
      limit: 10,
      returned_entries: 1,
      next_offset: null,
      truncated: true,
    });
    expect(oversizedPage2.plan?.entries).toMatchObject([
      { logical_path: "z-small.txt", status: "planned" },
    ]);

    // 5. Admitted ASAR with a 5 MiB invalid integrity hash skips the oversized entry at planLimit: 1 with an explicit oversized-entry limitation and stays under MAX_DRY_RUN_PLAN_PAGE_BYTES
    const asarPath = join(directory, "huge-invalid-hash.asar");
    const memberContent = Buffer.from("asar payload\n");
    const hugeInvalidHash = "z".repeat(5 * 1024 * 1024);
    await writeFile(
      asarPath,
      Buffer.concat([
        asarHeaderBytes(
          JSON.stringify({
            files: {
              "member.txt": {
                size: memberContent.length,
                offset: "0",
                integrity: {
                  algorithm: "SHA256",
                  hash: hugeInvalidHash,
                  blockSize: 4096,
                  blocks: [hugeInvalidHash.slice(0, 64)],
                },
              },
            },
          }),
        ),
        memberContent,
      ]),
    );
    const asarDryPage = await extractArtifact({
      inputPath: asarPath,
      inputFormat: "asar",
      outputRoot: join(directory, "asar-dry-out"),
      dryRun: true,
      planOffset: 0,
      planLimit: 1,
      environment: {},
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(asarDryPage.plan?.entries).toEqual([]);
    expect(asarDryPage.plan?.page).toEqual({
      total_entries: 1,
      offset: 0,
      limit: 1,
      returned_entries: 0,
      next_offset: null,
      truncated: true,
    });
    expect(
      asarDryPage.limitations.some(
        (item) =>
          item.startsWith(
            "Skipped dry-run plan entry at offset 0 (member.txt)",
          ) && item.includes("exceeds the maximum dry-run page budget"),
      ),
    ).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(asarDryPage), "utf8"),
    ).toBeLessThanOrEqual(MAX_DRY_RUN_PLAN_PAGE_BYTES);
  } finally {
    await resourceScope.close();
  }
});

it("preserves a published extraction receipt when signal aborts after SafeOutputTree publication and skips case probes without resourceScope", async () => {
  const directory = await createTestTempDirectory("rea-post-publish-abort-");
  await writeFile(join(directory, "CaseProbeSeed.txt"), "seed\n");

  const withoutScope = await SafeOutputTree.checkDestination(
    join(directory, "no-scope-out"),
  );
  expect(withoutScope.caseSensitivity).toBe("unknown");

  const zipPath = join(directory, "archive.zip");
  await writeFile(zipPath, await zipBytes("published content\n"));
  const controller = new AbortController();
  const originalCommit = SafeOutputTree.prototype.commit;
  const commitSpy = vi
    .spyOn(SafeOutputTree.prototype, "commit")
    .mockImplementation(async function (
      this: SafeOutputTree,
      signal?: AbortSignal,
    ) {
      await originalCommit.call(this, signal);
      controller.abort(new Error("late abort after publication"));
    });
  const resourceScope = new ArtifactResourceScope();
  try {
    const result = await extractArtifact(
      {
        inputPath: zipPath,
        inputFormat: "zip",
        outputRoot: join(directory, "published-out"),
        environment: {},
        integrityPolicy: "fail",
        resourceScope,
      },
      controller.signal,
    );
    expect(result.containment_verified).toBe(true);
    expect(result.artifacts).toHaveLength(1);
  } finally {
    commitSpy.mockRestore();
    await resourceScope.close();
  }
});
