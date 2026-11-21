import {
  open,
  readFile,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import {
  snapshotExecution,
  ANALYSIS_SNAPSHOT_PROFILE as PROFILE,
  ANALYSIS_SNAPSHOT_PROVIDER as PROVIDER,
  ANALYSIS_SNAPSHOT_TARGET as TARGET,
} from "../../../src/domain/analysisSnapshot.fixture.js";
import { join } from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";
import canonicalize from "canonicalize";

import { withArtifactResourceScope } from "../../fixtures/artifactInventory.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { holdFirstFileRead } from "../../support/holdFirstFileRead.js";

import { createAnalysisExecution } from "../../../src/ports/AnalysisProvider.js";
import {
  readAnalysisSnapshot,
  writeAnalysisSnapshot,
} from "../../../src/application/binary/AnalysisSnapshotFiles.js";
import {
  createAnalysisSnapshotEntry,
  parseAnalysisSnapshot,
  parsePreparedAnalysisSnapshot,
  prepareSnapshotEntry,
  snapshotBinding,
  snapshotTarget,
  type AnalysisSnapshot,
} from "../../../src/domain/analysisSnapshot.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { readJsonObjectFile } from "../../../src/application/JsonInputFile.js";
import { RegularFileChangedError } from "../../../src/filesystem/RegularFile.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { RegularFileCleanupFailure } from "../../../src/filesystem/OwnedRegularFile.js";
import { OwnedStagedOutput } from "../../../src/filesystem/OwnedStagedOutput.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

const snapshotFixture = (): AnalysisSnapshot => {
  const target = snapshotTarget(TARGET);
  const binding = snapshotBinding(PROFILE);
  const entry = createAnalysisSnapshotEntry({
    target,
    binding,
    operation: "address_name",
    parameters: { address: "0x1000" },
    execution: snapshotExecution(
      createAnalysisExecution(
        { name: "main", "😀": { "\uE000": "unicode" } },
        PROVIDER,
        {
          analysisProfile: PROFILE,
          rawResult: { name: "main", "😀": { "\uE000": "unicode" } },
          subject: {
            path: TARGET.path,
            sha256: TARGET.sha256,
            format: TARGET.format,
            ...(TARGET.architecture === undefined
              ? {}
              : { architecture: TARGET.architecture }),
          },
        },
      ),
    ),
  });
  const evidence = createEvidence(TARGET, PROVIDER, {
    operation: "address_name",
    parameters: { address: "0x1000" },
    result: { name: "main", "😀": { "\uE000": "unicode" } },
    rawResult: { name: "main", "😀": { "\uE000": "unicode" } },
    analysisProfile: PROFILE,
  });
  const snapshot: AnalysisSnapshot = {
    target,
    binding,
    entries: [entry],
    workflow_entries: [],
    evidence_bundle: createEvidenceBundle([evidence]),
  };
  return snapshot;
};

describe("analysis snapshots: persistence", () => {
  it("reports retained snapshot staging without an active provider and clears it after retry", async () => {
    const directory = await createTestTempDirectory(
      "rea-snapshot-cleanup-status-",
    );
    const path = join(directory, "analysis.json");
    const session = createTestBinarySession(() => {
      throw new Error("Snapshot persistence must not create a provider client");
    });
    const close = vi
      .spyOn(OwnedStagedOutput.prototype, "close")
      .mockRejectedValue(new Error("Controlled staging cleanup failure"));
    onTestFinished(async () => {
      close.mockRestore();
      const closed = await session.close();
      if (!closed.ok) throw closed.error;
    });

    const written = await session.writeAnalysisSnapshot(
      snapshotFixture(),
      path,
      false,
    );
    expect(written).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true, published: { path } },
    });
    expect(
      parseAnalysisSnapshot(JSON.parse(await readFile(path, "utf8"))),
    ).toEqual(snapshotFixture());
    expect(await session.status()).toMatchObject({
      open: false,
      cleanup_pending: true,
    });
    expect(await session.close()).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true },
    });
    expect(await session.status()).toMatchObject({ cleanup_pending: true });

    close.mockRestore();
    expect(await session.close()).toEqual({ ok: true, value: null });
    expect(await session.status()).toMatchObject({ cleanup_pending: false });
  });

  it("writes canonical private v2 JSON and rejects changed query identity", async () => {
    const directory = await createTestTempDirectory("rea-snapshot-");
    const path = join(directory, "analysis.json");
    const snapshot = snapshotFixture();
    const written = await withArtifactResourceScope((resources) =>
      writeAnalysisSnapshot(snapshot, path, false, resources),
    );
    if (!written.ok) throw written.error;
    const encoded = await readFile(path, "utf8");
    // RFC 8785 bytes are a storage contract, independent of snapshot decoding.
    expect(encoded).toBe(`${canonicalize(snapshot)}\n`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const roundTrip = await readAnalysisSnapshot(path);
    if (!roundTrip.ok) throw roundTrip.error;

    const entry = snapshot.entries[0]!;
    const altered = {
      ...snapshot,
      entries: [{ ...entry, parameters: { address: "0x2000" } }],
    };
    await writeFile(path, JSON.stringify(altered));
    expect(await readAnalysisSnapshot(path)).toMatchObject({
      ok: false,
      error: {
        _tag: "EvidenceIntegrityError",
        message: expect.stringContaining("identifier"),
      },
    });
  });
});

describe("analysis snapshot member decoding", () => {
  it("restores reordered legacy members with last-key semantics and authenticated shared payloads", async () => {
    const directory = await createTestTempDirectory("rea-snapshot-members-");
    const path = join(directory, "snapshot.json");
    const snapshot = snapshotFixture();
    const entry = snapshot.entries[0];
    if (entry === undefined) throw new Error("Missing fixture entry");
    const parts = [
      `"evidence_bundle":${JSON.stringify(snapshot.evidence_bundle)}`,
      '"entries":[{"bad":true}]',
      '"workflow_entries":null',
      `"binding":${JSON.stringify(snapshot.binding)}`,
      `"entries":${JSON.stringify(snapshot.entries)}`,
      `"target":${JSON.stringify(snapshot.target)}`,
      '"workflow_entries":[]',
      '"ignored":{"entries":["nested"]}',
    ];
    await writeFile(path, `${" ".repeat(9 * 1024 * 1024)}{${parts.join(",")}}`);
    const loaded = await readAnalysisSnapshot(path);
    if (!loaded.ok) throw loaded.error;
    expect(loaded.value).toEqual(snapshot);
    const restored = loaded.value.entries[0];
    const evidence = loaded.value.evidence_bundle.records[0];
    if (restored === undefined || evidence === undefined)
      throw new Error("Missing restored content");
    expect(restored.execution.result).toBe(evidence.normalized_result);
    expect(restored.execution.raw_result).toBe(evidence.raw_result);
    expect(Object.isFrozen(restored.execution)).toBe(true);
    expect(parseAnalysisSnapshot(loaded.value)).toBe(loaded.value);

    await writeFile(
      path,
      `${" ".repeat(9 * 1024 * 1024)}{${parts.join(",")},"entries":null}`,
    );
    const rejected = await readAnalysisSnapshot(path);
    expect(rejected).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceIntegrityError" },
    });
  });

  it.each(["result", "raw_result", "limitations", "provider"])(
    "rejects cache %s changes even when bundled Evidence is intact",
    async (field) => {
      const directory = await createTestTempDirectory("rea-snapshot-tamper-");
      const path = join(directory, "snapshot.json");
      const snapshot = snapshotFixture();
      const entry = snapshot.entries[0];
      if (entry === undefined) throw new Error("Missing fixture entry");
      Reflect.set(
        entry.execution,
        field,
        field === "limitations"
          ? ["changed"]
          : field === "provider"
            ? { ...PROVIDER, version: "changed" }
            : "changed",
      );
      await writeFile(path, JSON.stringify(snapshot));
      const loaded = await readAnalysisSnapshot(path);
      expect(loaded).toMatchObject({
        ok: false,
        error: { _tag: "EvidenceIntegrityError" },
      });
      if (!loaded.ok)
        expect(loaded.error.message).toMatch(
          field === "provider" ? /provider/u : /differs from/u,
        );
    },
  );

  it("validates skipped JSON syntax and UTF-8 and does not turn missing arrays into empty caches", async () => {
    const directory = await createTestTempDirectory("rea-snapshot-invalid-");
    const path = join(directory, "snapshot.json");
    const snapshot = snapshotFixture();
    const encoded = JSON.stringify(snapshot);
    for (const bytes of [
      Buffer.from(`${encoded.slice(0, -1)},"ignored":[1,]}`),
      Buffer.concat([
        Buffer.from(`${encoded.slice(0, -1)},"ignored":"`),
        Buffer.from([0xff]),
        Buffer.from('"}'),
      ]),
      Buffer.from(`\uFEFF${encoded}`),
    ]) {
      await writeFile(path, bytes);
      expect(await readAnalysisSnapshot(path)).toMatchObject({
        ok: false,
        error: { _tag: "EvidenceFileError", reason: "invalid-json" },
      });
    }
    const { workflow_entries: _workflows, ...missing } = snapshot;
    await writeFile(path, JSON.stringify(missing));
    expect(await readAnalysisSnapshot(path)).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceIntegrityError" },
    });
  });

  it("returns cancellation and permits the next complete read", async () => {
    const directory = await createTestTempDirectory("rea-snapshot-cancel-");
    const path = join(directory, "snapshot.json");
    const snapshot = snapshotFixture();
    await writeFile(
      path,
      `${" ".repeat(9 * 1024 * 1024)}${JSON.stringify(snapshot)}`,
    );
    const controller = new AbortController();
    const reason = { request: "cancel snapshot import" };
    const reads = await holdFirstFileRead(path);
    onTestFinished(() => {
      controller.abort();
      reads.release();
    });
    const pending = readAnalysisSnapshot(path, controller.signal);
    await reads.reached(pending, "first file read");
    controller.abort(reason);
    reads.release();
    try {
      expect(await pending).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisCancelledError",
          operation: "open_binary",
          cause: reason,
        },
      });
      expect(reads.readCount).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
    const loaded = await readAnalysisSnapshot(path);
    if (!loaded.ok) throw loaded.error;
    expect(loaded.value).toEqual(snapshot);
  });
});

describe("analysis snapshot file ownership", () => {
  it.each([false, true])(
    "retains the file owner when snapshot close fails (cancelled: %s)",
    async (cancelDuringClose) => {
      const directory = await createTestTempDirectory("rea-snapshot-cleanup-");
      const path = join(directory, "snapshot.json");
      await writeFile(path, JSON.stringify(snapshotFixture()));
      const controller = new AbortController();
      const cleanupCause = new Error("injected snapshot file close failure");
      const close = vi
        .spyOn(OwnedFileHandle.prototype, "close")
        .mockImplementationOnce(async () => {
          if (cancelDuringClose) controller.abort();
          throw cleanupCause;
        });
      let failure: unknown;
      try {
        const result = await readAnalysisSnapshot(
          path,
          cancelDuringClose ? controller.signal : undefined,
        );
        if (result.ok)
          throw new Error("Expected typed snapshot cleanup failure");
        expect(result.error.cleanupIncomplete).toBe(true);
        failure =
          cancelDuringClose && result.error.cause instanceof AggregateError
            ? result.error.cause.errors[1].cause
            : result.error.cause;
        expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
        if (!(failure instanceof RegularFileCleanupFailure))
          throw new Error("Expected the retained snapshot file handle owner");
        expect(failure.cleanupCause).toBe(cleanupCause);
        expect(failure.owner.handle.fd).toBeGreaterThanOrEqual(0);
      } finally {
        close.mockRestore();
        if (failure instanceof RegularFileCleanupFailure)
          await failure.owner.close();
      }
    },
  );

  it("rejects changed bytes between scans on the same descriptor", async () => {
    const directory = await createTestTempDirectory("rea-snapshot-changed-");
    const path = join(directory, "input.json");
    await writeFile(path, `${" ".repeat(9 * 1024 * 1024)}{"value":1}`);
    const reader = new Map([
      [
        "value",
        {
          mode: "value" as const,
          begin: () => undefined,
          accept: async () => {
            await writeFile(path, `${" ".repeat(9 * 1024 * 1024)}{"value":2}`);
          },
          reject: (cause: unknown) => {
            throw cause;
          },
        },
      ],
    ]);
    await expect(
      readJsonObjectFile(path, "test-input", [reader, new Map()]),
    ).rejects.toBeInstanceOf(RegularFileChangedError);
    expect((await readFile(path, "utf8")).trim()).toBe('{"value":2}');
  });

  it("rejects different bytes across scans with unchanged descriptor metadata", async () => {
    const directory = await createTestTempDirectory("rea-snapshot-scan-bytes-");
    const path = join(directory, "input.json");
    const document = '{"value":1}';
    await writeFile(path, document + " ".repeat(9 * 1024 * 1024));
    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe) as {
      read(
        this: FileHandle,
        ...args: [Buffer, number, number, number | null]
      ): Promise<{ readonly bytesRead: number; readonly buffer: Buffer }>;
    };
    const identity = await probe.stat();
    await probe.close();

    const observed: unknown[] = [];
    const read = prototype.read;
    const reading = vi
      .spyOn(prototype, "read")
      .mockImplementation(async function (this: FileHandle, ...args) {
        const result = await read.call(this, ...args);
        if (
          args[3] === 0 &&
          observed.length === 1 &&
          result.bytesRead >= document.length
        ) {
          const current = await this.stat();
          if (current.dev === identity.dev && current.ino === identity.ino)
            result.buffer[document.indexOf("1")] = "2".charCodeAt(0);
        }
        return result;
      });
    const reader = new Map([
      [
        "value",
        {
          mode: "value" as const,
          begin() {},
          accept(value: unknown) {
            observed.push(value);
          },
          reject(cause: unknown) {
            throw cause;
          },
        },
      ],
    ]);
    try {
      await expect(
        readJsonObjectFile(path, "test-input", [reader, reader]),
      ).rejects.toBeInstanceOf(RegularFileChangedError);
      expect(observed).toEqual([1, 2]);
    } finally {
      reading.mockRestore();
    }
    expect((await readFile(path, "utf8")).trim()).toBe(document);
  });
});

it("rejects copied preparation handles and prevents mutable caller values from changing authenticated cache content", () => {
  const snapshot = snapshotFixture();
  const entry = snapshot.entries[0];
  if (entry === undefined) throw new Error("Missing fixture entry");
  const prepared = prepareSnapshotEntry(entry, "provider");
  const forged = { ...prepared };
  expect(() => parsePreparedAnalysisSnapshot(snapshot, [forged], [])).toThrow(
    /not parsed in this realm/u,
  );
  const restored = parsePreparedAnalysisSnapshot(snapshot, [prepared], []);
  Reflect.set(entry.execution, "result", "changed after preparation");
  expect(restored.entries[0]?.execution.result).toEqual({
    name: "main",
    "😀": { "\uE000": "unicode" },
  });
  expect(() => parsePreparedAnalysisSnapshot(snapshot, [prepared], [])).toThrow(
    /not parsed in this realm/u,
  );
});

it.each([
  new Error("Parser callback state is unavailable"),
  new SyntaxError("selected member consumer failure"),
  Object.assign(new TypeError("consumer text decoder failure"), {
    code: "ERR_ENCODING_INVALID_ENCODED_DATA",
  }),
])(
  "preserves a selected-member callback failure instead of blaming JSON: %s",
  async (failure) => {
    const directory = await createTestTempDirectory("rea-json-member-failure-");
    const path = join(directory, "input.json");
    const members = new Map([
      [
        "value",
        {
          mode: "value" as const,
          begin: () => {
            throw failure;
          },
          accept: () => {
            throw new Error("Unexpected member acceptance");
          },
          reject: () => {
            throw new Error("Unexpected member rejection");
          },
        },
      ],
    ]);
    for (const padding of ["", " ".repeat(9 * 1024 * 1024)]) {
      await writeFile(path, `${padding}{"value":1}`);
      await expect(
        readJsonObjectFile(path, "test-input", [members]),
      ).rejects.toBe(failure);
    }
  },
);
