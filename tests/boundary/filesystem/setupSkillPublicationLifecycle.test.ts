import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { SkillFilePublication } from "../../../src/application/SkillFilePublication.js";
import {
  canonicalSkillNeedsInstall,
  installCanonicalSkill,
  MANAGED_SKILL_FILES,
  skillDestinations,
  type SkillInstallFileOperations,
} from "../../../src/application/SetupSkill.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const operations: SkillInstallFileOperations = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  backup: (source, destination) =>
    copyFile(source, destination, constants.COPYFILE_EXCL),
  prepare: SkillFilePublication.prepare,
};

it.each([false, true])(
  "installs through a home alias (existing: %s)",
  async (existing) => {
    const root = await createTestTempDirectory("rea-skill-home-alias-");
    const home = join(root, "home");
    const alias = join(root, "alias");
    await mkdir(home);
    await symlink(
      home,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const manifest = join(skillDestinations(home, [])[0]!.path, "SKILL.md");
    if (existing) {
      await mkdir(dirname(manifest), { recursive: true });
      await writeFile(manifest, "original\n");
    }
    expect(await installCanonicalSkill(alias)).toEqual({
      ok: true,
      value: "installed",
    });
    expect(await canonicalSkillNeedsInstall(home)).toBe(false);
    expect(await canonicalSkillNeedsInstall(alias)).toBe(false);
    expect(await installCanonicalSkill(alias)).toEqual({
      ok: true,
      value: "unchanged",
    });
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    if (existing)
      expect(await readFile(`${manifest}.rea.backup`, "utf8")).toBe(
        "original\n",
      );
  },
);

it.each([
  { scoped: false, failWrite: false },
  { scoped: true, failWrite: false },
  { scoped: false, failWrite: true },
  { scoped: true, failWrite: true },
])(
  "retains independent cleanup owners and primary outcome ($scoped/$failWrite)",
  async ({ scoped, failWrite }) => {
    const home = await createTestTempDirectory("rea-skill-cleanup-retries-");
    const root = skillDestinations(home, [])[0]!.path;
    for (const relative of MANAGED_SKILL_FILES) {
      await mkdir(dirname(join(root, relative)), { recursive: true });
      await writeFile(join(root, relative), `original ${relative}\n`);
    }
    const scope = scoped ? new ArtifactResourceScope() : undefined;
    const blocked = [true, true];
    const owners: SkillFilePublication[] = [];
    const failure = new Error("later publication denied");
    let index = 0;
    try {
      const result = await installCanonicalSkill(
        home,
        [],
        {},
        process.platform,
        {
          ...operations,
          prepare: async (...args) => {
            const selected = index++;
            if (failWrite && selected === 2) throw failure;
            const publication = await SkillFilePublication.prepare(...args);
            if (selected < 2) {
              owners.push(publication);
              const release = publication.lease.release.bind(publication.lease);
              vi.spyOn(publication.lease, "release").mockImplementation(
                async () => {
                  if (blocked[selected])
                    throw new Error(`cleanup denied ${selected}`);
                  await release();
                },
              );
            }
            return publication;
          },
        },
        scope,
      );
      if (result.ok) throw new Error("Expected retained cleanup failure");
      expect(owners).toHaveLength(2);
      expect(owners.every((owner) => !owner.lease.released)).toBe(true);
      expect(result.error.rollbackFailures).toEqual(
        owners.map((owner, index) => ({
          path: owner.resource,
          reason: `cleanup denied ${index}`,
        })),
      );
      expect(
        result.error.cleanupOwners.filter((owner) => !owner.lease.released),
      ).toEqual(owners);
      if (failWrite) {
        expect(result.error.cause).toBe(failure);
        expect(result.error.reason).toBe(failure.message);
        expect(result.error.stage).toBe("write");
        for (const relative of MANAGED_SKILL_FILES)
          expect(await readFile(join(root, relative), "utf8")).toBe(
            `original ${relative}\n`,
          );
      } else {
        expect(result.error.reason).toContain("cleanup incomplete");
        expect(await canonicalSkillNeedsInstall(home)).toBe(false);
      }
      const reason = result.error.reason;
      const cause = result.error.cause;
      blocked[0] = false;
      if (scope !== undefined) {
        expect(scope.hasPending).toBe(true);
        await expect(scope.retryCleanup()).rejects.toBeDefined();
        expect(scope.hasPending).toBe(true);
      } else
        expect(await result.error.retryCleanup()).toEqual([
          { path: owners[1]!.resource, reason: "cleanup denied 1" },
        ]);
      expect(owners[0]!.lease.released).toBe(true);
      expect(owners[1]!.lease.released).toBe(false);
      blocked[1] = false;
      if (scope !== undefined) {
        await scope.retryCleanup();
        expect(scope.hasPending).toBe(false);
      } else expect(await result.error.retryCleanup()).toEqual([]);
      expect(owners.every((owner) => owner.lease.released)).toBe(true);
      expect(result.error.reason).toBe(reason);
      expect(result.error.cause).toBe(cause);
      if (failWrite) {
        for (const relative of MANAGED_SKILL_FILES)
          expect(await readFile(join(root, relative), "utf8")).toBe(
            `original ${relative}\n`,
          );
      } else expect(await canonicalSkillNeedsInstall(home)).toBe(false);
    } finally {
      blocked.fill(false);
      for (const owner of owners) await owner.close();
      await scope?.close();
    }
  },
);
