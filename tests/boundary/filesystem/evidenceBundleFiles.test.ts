import {
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { withArtifactResourceScope } from "../../fixtures/artifactInventory.js";

import {
  readEvidenceBundle,
  readImmutableEvidenceBundle,
  writeEvidenceBundle,
} from "../../../src/application/EvidenceBundleFiles.js";
import { compareEvidenceBundlesCommand } from "../../../src/application/EvidenceBundleCommands.js";
import { EvidenceLedger } from "../../../src/application/investigation/EvidenceLedger.js";
import { RegularFileCleanupFailure } from "../../../src/application/RegularFileRead.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { writeTextParts } from "../../../src/application/JsonFiles.js";
import {
  createEvidenceBundle,
  serializeEvidenceBundle,
} from "../../../src/domain/evidenceBundle.js";

const bundle = (result = true) =>
  createEvidenceBundle([
    createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      { operation: "health", parameters: {}, result },
    ),
  ]);

it("returns import cancellation before inspecting a selected path", async () => {
  const root = await createTestTempDirectory("rea-import-pre-cancel-");
  const controller = new AbortController();
  controller.abort(new Error("cancel before import"));
  expect(
    await readImmutableEvidenceBundle(
      join(root, "missing.json"),
      controller.signal,
    ),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCancelledError",
      operation: "import_evidence_bundle",
    },
  });
  expect(await readdir(root)).toEqual([]);
});

it("preserves the failed-close owner when import is also cancelled", async () => {
  const root = await createTestTempDirectory("rea-import-cancel-cleanup-");
  const path = join(root, "bundle.json");
  await writeFile(path, JSON.stringify(bundle()));
  const controller = new AbortController();
  const cleanupCause = new Error("fixture close failure");
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementationOnce(async () => {
      controller.abort(new Error("cancel during cleanup"));
      throw cleanupCause;
    });
  let failure: unknown;
  try {
    try {
      await readImmutableEvidenceBundle(path, controller.signal);
    } catch (cause: unknown) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
    if (!(failure instanceof RegularFileCleanupFailure))
      throw new Error("Expected the retained file handle owner");
    expect(failure.cleanupCause).toBe(cleanupCause);
  } finally {
    close.mockRestore();
    if (failure instanceof RegularFileCleanupFailure)
      await failure.owner.close();
  }
  expect(await readEvidenceBundle(path)).toMatchObject({ ok: true });
});

describe("evidence bundle export cancellation", () => {
  it("does not inspect the path or advance a source cancelled before writing", async () => {
    const root = await createTestTempDirectory("rea-export-pre-cancel-");
    const controller = new AbortController();
    controller.abort();
    let advanced = false;
    function* parts() {
      advanced = true;
      yield "unused";
    }
    expect(
      await writeParts(parts(), join(root, "missing", "bundle.json"), false, {
        signal: controller.signal,
        operation: "export_evidence_bundle",
      }),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        operation: "export_evidence_bundle",
      },
    });
    expect(advanced).toBe(false);
    expect(await readdir(root)).toEqual([]);
    expect(
      await writeBundle(
        bundle(),
        join(root, "bundle.json"),
        false,
        controller.signal,
      ),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
    expect(await readdir(root)).toEqual([]);
  });

  it.each([false, true])(
    "closes a cancelled source and preserves the destination (overwrite: %s)",
    async (overwrite) => {
      const root = await createTestTempDirectory("rea-export-cancel-");
      const path = join(root, "bundle.json");
      if (overwrite) await writeFile(path, "original");
      const controller = new AbortController();
      let closed = false;
      let continued = false;
      function* parts() {
        try {
          yield "staged partial data";
          controller.abort();
          yield "cancelled data";
          continued = true;
          yield "unreachable";
        } finally {
          closed = true;
        }
      }
      expect(
        await writeParts(parts(), path, overwrite, {
          signal: controller.signal,
          operation: "export_evidence_bundle",
        }),
      ).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisCancelledError",
          operation: "export_evidence_bundle",
        },
      });
      expect(closed).toBe(true);
      expect(continued).toBe(false);
      expect(await readdir(root)).toEqual(overwrite ? ["bundle.json"] : []);
      if (overwrite) expect(await readFile(path, "utf8")).toBe("original");
      expect(await writeBundle(bundle(), path, overwrite)).toMatchObject({
        ok: true,
      });
      expect(await readEvidenceBundle(path)).toEqual({
        ok: true,
        value: bundle(),
      });
    },
  );

  it("does not publish when cancellation arrives at source exhaustion", async () => {
    const root = await createTestTempDirectory("rea-export-final-cancel-");
    const path = join(root, "bundle.json");
    await writeFile(path, "original");
    const controller = new AbortController();
    function* parts() {
      yield "complete replacement";
      controller.abort();
    }
    expect(
      await writeParts(parts(), path, true, {
        signal: controller.signal,
        operation: "export_evidence_bundle",
      }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
    expect(await readFile(path, "utf8")).toBe("original");
    expect(await readdir(root)).toEqual(["bundle.json"]);
  });
});

const writeBundle = (
  value: ReturnType<typeof bundle>,
  path: string,
  overwrite: boolean,
  signal?: AbortSignal,
) =>
  withArtifactResourceScope((resources) =>
    writeEvidenceBundle(value, path, overwrite, resources, signal),
  );

const writeParts = (
  parts: Iterable<string>,
  path: string,
  overwrite: boolean,
  cancellation?: {
    readonly signal: AbortSignal;
    readonly operation: string;
  },
) =>
  withArtifactResourceScope((resources) =>
    writeTextParts(parts, path, overwrite, resources, cancellation),
  );

describe("evidence bundle publication", () => {
  it.each([false, true])(
    "never publishes a partial streamed file (overwrite: %s)",
    async (overwrite) => {
      const root = await createTestTempDirectory("rea-stream-publication-");
      const path = join(root, "bundle.json");
      if (overwrite) await writeFile(path, "original");
      function* brokenParts() {
        yield "partial";
        throw new Error("Source stream failed");
      }
      expect(await writeParts(brokenParts(), path, overwrite)).toMatchObject({
        ok: false,
        error: { _tag: "EvidenceFileError", reason: "io" },
      });
      expect(await readdir(root)).toEqual(overwrite ? ["bundle.json"] : []);
      if (overwrite) expect(await readFile(path, "utf8")).toBe("original");
    },
  );

  it("counts complete Unicode bytes and publishes a private file", async () => {
    const root = await createTestTempDirectory("rea-stream-bytes-");
    const path = join(root, "bundle.json");
    const parts = ["雪", "😀", "\n"];
    expect(await writeParts(parts, path, false)).toEqual({
      ok: true,
      value: { path, bytes: Buffer.byteLength(parts.join("")) },
    });
    expect(await readFile(path, "utf8")).toBe(parts.join(""));
    if (process.platform !== "win32")
      expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it("allows only one simultaneous export without overwrite approval", async () => {
    const root = await createTestTempDirectory("rea-evidence-exclusive-");
    const path = join(root, "bundle.json");
    const candidates = [bundle(), bundle(false)];
    const results = await Promise.all(
      candidates.map((value) => writeBundle(value, path, false)),
    );
    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter(({ ok }) => !ok)).toMatchObject([
      { ok: false, error: { _tag: "EvidenceFileError", reason: "exists" } },
    ]);
    const winner = candidates[results.findIndex(({ ok }) => ok)];
    expect(await readEvidenceBundle(path)).toEqual({
      ok: true,
      value: winner,
    });
    expect(await readdir(root)).toEqual(["bundle.json"]);
  });

  it("round trips caller-selected paths without configured roots", async () => {
    const root = await createTestTempDirectory("rea-evidence-dot-child-");
    const directory = join(root, "..cache");
    await mkdir(directory);
    const path = join(directory, "bundle.json");
    const value = bundle();
    expect(await writeBundle(value, path, false)).toMatchObject({
      ok: true,
    });
    expect(await readEvidenceBundle(path)).toEqual({
      ok: true,
      value,
    });
  });
});

it("reuses authenticated file snapshots while isolating mutable public reads", async () => {
  const directory = await createTestTempDirectory("rea-evidence-owned-");
  const path = join(directory, "bundle.json");
  const evidence = createEvidence(
    {
      path: "/local/observed-target",
      sha256: "a".repeat(64),
      format: "file",
    },
    { id: "fixture", name: "Fixture", version: "1" },
    { operation: "health", parameters: {}, result: { nested: [true] } },
  );
  const source = serializeEvidenceBundle(createEvidenceBundle([evidence]));
  await writeFile(path, source);
  const mutable = await readEvidenceBundle(path);
  if (!mutable.ok) throw mutable.error;
  expect(Object.isFrozen(mutable.value.records[0])).toBe(false);
  const loaded = await readImmutableEvidenceBundle(path);
  if (!loaded.ok) throw loaded.error;
  const record = loaded.value.records[0];
  if (record === undefined) throw new Error("Expected an imported record");
  expect(record).toEqual(evidence);
  expect(Object.isFrozen(loaded.value)).toBe(true);
  expect(Object.isFrozen(record.normalized_result)).toBe(true);
  expect(Reflect.set(record, "operation", "forged")).toBe(false);

  const ledger = new EvidenceLedger();
  const imported = ledger.import(loaded.value);
  if (!imported.ok) throw imported.error;
  expect(imported.value).toMatchObject({ recordsAdded: 1, changed: true });
  expect(ledger.forAnalysis(evidence.evidence_id)).toBe(record);
  const detached = ledger.get(evidence.evidence_id);
  if (detached === undefined) throw new Error("Expected a detached record");
  expect(Reflect.set(detached, "normalized_result", false)).toBe(true);
  expect(ledger.record(detached).ok).toBe(false);
  expect(ledger.export()).toEqual(loaded.value);
  expect(await readFile(path, "utf8")).toBe(source);
  ledger.clear();
});

describe("evidence bundle filesystem adapter", () => {
  it("round trips canonical bytes and requires explicit overwrite", async () => {
    const directory = await createTestTempDirectory("rea-evidence-");
    const path = join(directory, "bundle.json");
    const evidenceBundle = bundle();
    const first = await writeBundle(evidenceBundle, path, false);
    expect(first).toMatchObject({ ok: true, value: { path } });
    expect(await readFile(path, "utf8")).toBe(
      serializeEvidenceBundle(evidenceBundle),
    );
    expect(await readEvidenceBundle(path)).toEqual({
      ok: true,
      value: evidenceBundle,
    });
    expect(
      await compareEvidenceBundlesCommand({
        leftPath: path,
        rightPath: path,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        status: "unchanged",
        summary: { records_unchanged: 1 },
      },
    });
    expect(await writeBundle(evidenceBundle, path, false)).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceFileError", reason: "exists" },
    });
    expect(await writeBundle(evidenceBundle, path, true)).toMatchObject({
      ok: true,
    });
  });

  it("reads the caller-selected symlink target and refuses to replace a symlink", async () => {
    const directory = await createTestTempDirectory("rea-evidence-");
    const outside = join(directory, "outside");
    await mkdir(outside);
    const outsidePath = join(outside, "bundle.json");
    await writeFile(outsidePath, serializeEvidenceBundle(bundle()));
    const link = join(directory, "escaped.json");
    await symlink(outsidePath, link);
    expect(await readEvidenceBundle(link)).toMatchObject({
      ok: true,
      value: bundle(),
    });
    expect(await writeBundle(bundle(), link, true)).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceFileError", reason: "not-file" },
    });
  });

  it("reports a missing file or output directory with the selected path", async () => {
    const directory = await createTestTempDirectory("rea-evidence-");
    const absent = join(directory, "absent.json");
    const read = await readEvidenceBundle(absent);
    expect(read).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceFileError", reason: "missing", path: absent },
    });
    if (read.ok) throw new Error("Expected a missing-file failure");
    expect(projectAnalysisError(read.error)).toMatchObject({
      message: expect.stringContaining("does not exist at the selected path"),
      details: { operation: "read", reason: "missing", path: absent },
    });

    const orphan = join(directory, "absent", "bundle.json");
    const written = await writeBundle(bundle(), orphan, false);
    expect(written).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceFileError", reason: "missing", path: orphan },
    });
    if (written.ok) throw new Error("Expected a missing-directory failure");
    expect(projectAnalysisError(written.error).message).toContain(
      "output directory does not exist",
    );
  });

  it.each([readEvidenceBundle, readImmutableEvidenceBundle])(
    "rejects malformed and tampered input (%s)",
    async (readBundle) => {
      const directory = await createTestTempDirectory("rea-evidence-");
      const malformed = join(directory, "malformed.json");
      await writeFile(malformed, "{");
      expect(await readBundle(malformed)).toMatchObject({
        ok: false,
        error: { _tag: "EvidenceFileError", reason: "invalid-json" },
      });

      const tampered = bundle();
      const tamperedPath = join(directory, "tampered.json");
      await writeFile(
        tamperedPath,
        JSON.stringify({
          ...tampered,
          records: [{ ...tampered.records[0], normalized_result: "changed" }],
        }),
      );
      expect(await readBundle(tamperedPath)).toMatchObject({
        ok: false,
        error: {
          _tag: "EvidenceIntegrityError",
          userMessage: expect.stringContaining(
            "at records.0.evidence_id: Evidence semantic identifier does not match its record",
          ),
        },
      });
    },
  );

  it("names the failed bundle constraint for a single record or schema mismatch", async () => {
    const directory = await createTestTempDirectory("rea-evidence-");
    const record = bundle().records[0];
    const single = join(directory, "record.json");
    await writeFile(single, JSON.stringify(record));
    expect(await readEvidenceBundle(single)).toMatchObject({
      ok: false,
      error: {
        _tag: "EvidenceIntegrityError",
        userMessage: expect.stringContaining(
          `this JSON is one Evidence record (${String(record?.evidence_id)})`,
        ),
      },
    });

    const partial = join(directory, "partial.json");
    await writeFile(partial, JSON.stringify({ evidence_id: "typo" }));
    const rejected = await readEvidenceBundle(partial);
    expect(rejected).toMatchObject({
      ok: false,
      error: {
        userMessage: expect.stringContaining(
          "does not match the bundle schema",
        ),
      },
    });
    expect(rejected).not.toMatchObject({
      error: { userMessage: expect.stringContaining("one Evidence record") },
    });

    const mismatched = join(directory, "mismatched.json");
    await writeFile(mismatched, JSON.stringify({ ...bundle(), records: {} }));
    expect(await readEvidenceBundle(mismatched)).toMatchObject({
      ok: false,
      error: {
        _tag: "EvidenceIntegrityError",
        userMessage: expect.stringContaining(
          "does not match the bundle schema at records:",
        ),
      },
    });
  });
});
