import {
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  readEvidenceBundle,
  writeEvidenceBundle,
} from "../../../src/application/EvidenceBundleFiles.js";
import { compareEvidenceBundlesCommand } from "../../../src/application/EvidenceBundleCommands.js";
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
      await writeTextParts(
        parts(),
        join(root, "missing", "bundle.json"),
        false,
        {
          signal: controller.signal,
          operation: "export_evidence_bundle",
        },
      ),
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
      await writeEvidenceBundle(
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
        await writeTextParts(parts(), path, overwrite, {
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
      expect(
        await writeEvidenceBundle(bundle(), path, overwrite),
      ).toMatchObject({ ok: true });
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
      await writeTextParts(parts(), path, true, {
        signal: controller.signal,
        operation: "export_evidence_bundle",
      }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
    expect(await readFile(path, "utf8")).toBe("original");
    expect(await readdir(root)).toEqual(["bundle.json"]);
  });
});

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
      expect(
        await writeTextParts(brokenParts(), path, overwrite),
      ).toMatchObject({
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
    expect(await writeTextParts(parts, path, false)).toEqual({
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
      candidates.map((value) => writeEvidenceBundle(value, path, false)),
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
    expect(await writeEvidenceBundle(value, path, false)).toMatchObject({
      ok: true,
    });
    expect(await readEvidenceBundle(path)).toEqual({
      ok: true,
      value,
    });
  });
});

describe("evidence bundle filesystem adapter", () => {
  it("round trips canonical bytes and requires explicit overwrite", async () => {
    const directory = await createTestTempDirectory("rea-evidence-");
    const path = join(directory, "bundle.json");
    const evidenceBundle = bundle();
    const first = await writeEvidenceBundle(evidenceBundle, path, false);
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
    expect(
      await writeEvidenceBundle(evidenceBundle, path, false),
    ).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceFileError", reason: "exists" },
    });
    expect(await writeEvidenceBundle(evidenceBundle, path, true)).toMatchObject(
      { ok: true },
    );
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
    expect(await writeEvidenceBundle(bundle(), link, true)).toMatchObject({
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
    const written = await writeEvidenceBundle(bundle(), orphan, false);
    expect(written).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceFileError", reason: "missing", path: orphan },
    });
    if (written.ok) throw new Error("Expected a missing-directory failure");
    expect(projectAnalysisError(written.error).message).toContain(
      "output directory does not exist",
    );
  });

  it("rejects malformed and tampered input", async () => {
    const directory = await createTestTempDirectory("rea-evidence-");
    const malformed = join(directory, "malformed.json");
    await writeFile(malformed, "{");
    expect(await readEvidenceBundle(malformed)).toMatchObject({
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
    expect(await readEvidenceBundle(tamperedPath)).toMatchObject({
      ok: false,
      error: {
        _tag: "EvidenceIntegrityError",
        userMessage: expect.stringContaining(
          "Evidence semantic identifier does not match its record",
        ),
      },
    });
  });

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
