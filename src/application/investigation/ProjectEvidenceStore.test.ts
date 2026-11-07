import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { FUNCTION_COMPARISON_EXAMPLE } from "../../contracts/functionComparisonExample.js";
import { withEvidenceCallerInputPath } from "../../domain/evidence.js";
import { ProjectEvidenceStore } from "./ProjectEvidenceStore.js";

const dossier = FUNCTION_COMPARISON_EXAMPLE.left;

/** Run one store case against a private directory that is always removed. */
const withStoreRoot = async (
  prefix: string,
  run: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

/** Persist one record and return its records directory. */
const seed = async (root: string): Promise<string> => {
  const store = new ProjectEvidenceStore(root);
  store.persist(dossier);
  expect(await store.flush()).toMatchObject({ ok: true });
  return join(root, "records");
};

it("retries a record whose durable write first failed", () =>
  withStoreRoot("rea-store-retry-", async (root) => {
    // A plain file where the store needs a directory blocks every write.
    const blocked = join(root, "blocked");
    await writeFile(blocked, "");
    const store = new ProjectEvidenceStore(join(blocked, "evidence"));
    store.persist(dossier);
    const failed = await store.flush();
    expect(failed.ok).toBe(false);
    expect(store.read(dossier.evidence_id)).toBeUndefined();

    await rm(blocked, { recursive: true, force: true });
    const retried = await store.flush();
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    expect(store.read(dossier.evidence_id)).toEqual(dossier);
  }));

it("refuses a record path that is not a regular file", () =>
  withStoreRoot("rea-store-notfile-", async (root) => {
    const records = await seed(root);
    const path = join(records, `${dossier.evidence_id}.json`);
    expect(new ProjectEvidenceStore(root).read(dossier.evidence_id)).toEqual(
      dossier,
    );

    await rm(path);
    await mkdir(path);
    expect(new ProjectEvidenceStore(root).read(dossier.evidence_id)).toBe(
      undefined,
    );
    await rm(path, { recursive: true });
    await symlink("elsewhere.json", path);
    expect(new ProjectEvidenceStore(root).read(dossier.evidence_id)).toBe(
      undefined,
    );
    expect(new ProjectEvidenceStore(root).has(dossier.evidence_id)).toBe(false);
  }));

it("refuses an oversized record file before allocating it", () =>
  withStoreRoot("rea-store-oversize-", async (root) => {
    const records = await seed(root);
    // A sparse file reports a size beyond the record ceiling without filling disk.
    await truncate(
      join(records, `${dossier.evidence_id}.json`),
      65 * 1024 * 1024,
    );
    expect(new ProjectEvidenceStore(root).read(dossier.evidence_id)).toBe(
      undefined,
    );
  }));

it("keeps the newest display metadata for a relocated record", () =>
  withStoreRoot("rea-store-relocate-", async (root) => {
    const records = await seed(root);
    const relocated = withEvidenceCallerInputPath(
      dossier,
      join(root, "moved-target"),
    );
    expect(relocated.evidence_id).toBe(dossier.evidence_id);

    const store = new ProjectEvidenceStore(root);
    store.persist(relocated);
    expect(await store.flush()).toMatchObject({ ok: true });
    expect(store.read(dossier.evidence_id)).toEqual(relocated);
    expect(await readdir(records)).toEqual([`${dossier.evidence_id}.json`]);
  }));

it("releases retained reads so a replaced record is re-authenticated", () =>
  withStoreRoot("rea-store-release-", async (root) => {
    const records = await seed(root);
    const store = new ProjectEvidenceStore(root);
    expect(store.read(dossier.evidence_id)).toEqual(dossier);

    await writeFile(
      join(records, `${dossier.evidence_id}.json`),
      JSON.stringify({ ...dossier, limitations: ["tampered"] }),
    );
    // A retained read still answers until the closed session releases it.
    expect(store.read(dossier.evidence_id)).toEqual(dossier);
    store.releaseCachedReads();
    expect(store.read(dossier.evidence_id)).toBeUndefined();
  }));
