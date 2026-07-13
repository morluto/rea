import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readEvidenceBundle,
  writeEvidenceBundle,
} from "../src/application/EvidenceBundleFiles.js";
import { compareEvidenceBundlesCommand } from "../src/application/EvidenceBundleCommands.js";
import { createEvidence } from "../src/domain/evidence.js";
import {
  createEvidenceBundle,
  serializeEvidenceBundle,
  type EvidenceFilePolicy,
} from "../src/domain/evidenceBundle.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

const bundle = () =>
  createEvidenceBundle([
    createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      { operation: "health", parameters: {}, result: true },
    ),
  ]);

const policy = (root: string): EvidenceFilePolicy => ({
  roots: [root],
  maxBytes: 1024 * 1024,
  maxDepth: 64,
  maxStringLength: 1024,
  maxNodes: 10_000,
});

describe("evidence bundle filesystem adapter", () => {
  it("round trips canonical bytes and requires explicit overwrite", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-evidence-"));
    const path = join(directory, "bundle.json");
    const evidenceBundle = bundle();
    const first = await writeEvidenceBundle(
      evidenceBundle,
      path,
      false,
      policy(directory),
    );
    expect(first).toMatchObject({ ok: true, value: { path } });
    expect(await readFile(path, "utf8")).toBe(
      serializeEvidenceBundle(evidenceBundle),
    );
    expect(await readEvidenceBundle(path, policy(directory))).toEqual({
      ok: true,
      value: evidenceBundle,
    });
    expect(
      await compareEvidenceBundlesCommand({
        leftPath: path,
        rightPath: path,
        offset: 0,
        limit: 100,
        policy: policy(directory),
      }),
    ).toMatchObject({
      ok: true,
      value: {
        status: "unchanged",
        summary: { records_unchanged: 1 },
      },
    });
    expect(
      await writeEvidenceBundle(evidenceBundle, path, false, policy(directory)),
    ).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceFileError", reason: "exists" },
    });
    expect(
      await writeEvidenceBundle(evidenceBundle, path, true, policy(directory)),
    ).toMatchObject({ ok: true });
  });

  it("rejects traversal and symlink escape from approved roots", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-evidence-"));
    const root = join(directory, "approved");
    const outside = join(directory, "outside");
    await mkdir(root);
    await mkdir(outside);
    const outsidePath = join(outside, "bundle.json");
    await writeFile(outsidePath, serializeEvidenceBundle(bundle()));
    const link = join(root, "escaped.json");
    await symlink(outsidePath, link);
    expect(await readEvidenceBundle(link, policy(root))).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceFileError", reason: "outside-root" },
    });
    expect(
      await writeEvidenceBundle(bundle(), outsidePath, true, policy(root)),
    ).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceFileError", reason: "outside-root" },
    });
  });

  it("rejects malformed, tampered, oversized, and deeply nested input", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-evidence-"));
    const malformed = join(directory, "malformed.json");
    await writeFile(malformed, "{");
    expect(
      await readEvidenceBundle(malformed, policy(directory)),
    ).toMatchObject({
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
    expect(
      await readEvidenceBundle(tamperedPath, policy(directory)),
    ).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceIntegrityError" },
    });

    const oversized = join(directory, "oversized.json");
    await writeFile(oversized, "x".repeat(100));
    expect(
      await readEvidenceBundle(oversized, {
        ...policy(directory),
        maxBytes: 10,
      }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceFileError", reason: "too-large" },
    });

    const deep = join(directory, "deep.json");
    await writeFile(deep, JSON.stringify({ one: { two: { three: null } } }));
    expect(
      await readEvidenceBundle(deep, {
        ...policy(directory),
        maxDepth: 1,
      }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceFileError", reason: "too-large" },
    });
  });
});
