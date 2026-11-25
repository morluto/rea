import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { directoryTreeDigest } from "../../domain/directoryTreeDigest.js";
import { ArtifactResourceScope } from "../../resources/ArtifactResourceScope.js";
import { inventoryArtifact } from "./ArtifactInventory.js";

const sha = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

const inventory = async (
  path: string,
  acquisitionLimits?: { maximumEntries: number; maximumBytes: number },
) => {
  const resourceScope = new ArtifactResourceScope();
  try {
    return await inventoryArtifact(path, {
      environment: {},
      resourceScope,
      ...(acquisitionLimits === undefined ? {} : { acquisitionLimits }),
    });
  } finally {
    await resourceScope.close();
  }
};

/** A small build output: one executable and a shader folder. */
const writeBuild = async (
  root: string,
  shader: Buffer,
  order: "forward" | "reverse",
): Promise<void> => {
  const steps = [
    () => mkdir(join(root, "shaders")),
    () => writeFile(join(root, "app.exe"), "MZ\u0090\u0000"),
    () => mkdir(join(root, "empty")),
  ];
  for (const step of order === "forward" ? steps : [...steps].reverse())
    await step();
  await writeFile(join(root, "shaders", "a.spv"), shader);
};

const SPIRV = Buffer.from([0x03, 0x02, 0x23, 0x07, 0x00, 0x00, 0x01, 0x00]);

describe("directory root digest", () => {
  it("names the same tree with the same digest, whatever its location, order, times or modes", async () => {
    const base = await createTestTempDirectory("rea-tree-digest-same-");
    const left = join(base, "left");
    const right = join(base, "elsewhere", "right");
    await mkdir(left);
    await mkdir(right, { recursive: true });
    await writeBuild(left, SPIRV, "forward");
    await writeBuild(right, SPIRV, "reverse");
    await utimes(join(right, "app.exe"), 1, 1);
    if (process.platform !== "win32")
      await chmod(join(right, "app.exe"), 0o755);

    const [one, two] = [await inventory(left), await inventory(right)];
    const expected = directoryTreeDigest([
      { kind: "file", path: "app.exe", sha256: sha("MZ\u0090\u0000") },
      { kind: "directory", path: "empty" },
      { kind: "directory", path: "shaders" },
      { kind: "file", path: "shaders/a.spv", sha256: sha(SPIRV) },
    ]);
    expect(one.root_digest).toEqual({
      algorithm: "rea-directory-tree",
      version: 1,
      status: "complete",
      sha256: expected,
      member_count: 4,
    });
    expect(two.root_digest).toEqual(one.root_digest);
    expect(one.manifest).toMatchObject({
      root_format: "directory",
      root_sha256: expected,
    });
  });

  it("changes when one content byte changes", async () => {
    const base = await createTestTempDirectory("rea-tree-digest-byte-");
    await mkdir(join(base, "a"));
    await mkdir(join(base, "b"));
    await writeBuild(join(base, "a"), SPIRV, "forward");
    const flipped = Buffer.from(SPIRV);
    flipped[7] = 0x02;
    await writeBuild(join(base, "b"), flipped, "forward");
    const [a, b] = [
      await inventory(join(base, "a")),
      await inventory(join(base, "b")),
    ];
    expect(a.root_digest?.status).toBe("complete");
    expect(b.root_digest?.status).toBe("complete");
    expect(a.manifest.root_sha256).not.toBe(b.manifest.root_sha256);
  });

  it("gives the empty directory the header-only digest", async () => {
    const root = await createTestTempDirectory("rea-tree-digest-empty-");
    const result = await inventory(root);
    expect(result.root_digest).toEqual({
      algorithm: "rea-directory-tree",
      version: 1,
      status: "complete",
      sha256:
        "b28a57a57239d69019456fc9079821c5f31911fc656d15ff77703cb13991b3b6",
      member_count: 0,
    });
  });

  it.skipIf(process.platform === "win32")(
    "records a symlink's target without following it",
    async () => {
      const base = await createTestTempDirectory("rea-tree-digest-link-");
      const root = join(base, "root");
      await mkdir(root);
      await writeFile(join(base, "outside.txt"), "first");
      await symlink("../outside.txt", join(root, "link"));
      const first = await inventory(root);
      expect(
        first.occurrences.find(({ logical_path }) => logical_path === "link"),
      ).toMatchObject({
        entry_kind: "symlink",
        link_target: {
          text: "../outside.txt",
          hex: Buffer.from("../outside.txt").toString("hex"),
        },
      });
      expect(first.root_digest).toMatchObject({
        status: "complete",
        sha256: directoryTreeDigest([
          {
            kind: "symlink",
            path: "link",
            targetHex: Buffer.from("../outside.txt").toString("hex"),
          },
        ]),
      });

      await writeFile(join(base, "outside.txt"), "second");
      expect((await inventory(root)).root_digest).toEqual(first.root_digest);

      await writeFile(join(base, "other.txt"), "first");
      await rm(join(root, "link"));
      await symlink("../other.txt", join(root, "link"));
      expect((await inventory(root)).manifest.root_sha256).not.toBe(
        first.manifest.root_sha256,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "records a FIFO by kind without reading it",
    async () => {
      const root = await createTestTempDirectory("rea-tree-digest-fifo-");
      execFileSync("mkfifo", [join(root, "pipe")]);
      const result = await inventory(root);
      expect(result.root_digest).toMatchObject({
        status: "complete",
        sha256: directoryTreeDigest([{ kind: "fifo", path: "pipe" }]),
      });
    },
  );
});

describe("directory root digest names and limits", () => {
  // Linux file systems store both spellings; APFS, HFS+ and NTFS fold them.
  it.runIf(process.platform === "linux")(
    "keeps two names that differ only in Unicode normalization as two members",
    async () => {
      const base = await createTestTempDirectory("rea-tree-digest-nfc-");
      const tree = async (
        name: string,
        composed: string,
        decomposed: string,
      ) => {
        const root = join(base, name);
        await mkdir(root);
        await writeFile(join(root, "é"), composed);
        await writeFile(join(root, "é"), decomposed);
        return inventory(root);
      };
      const one = await tree("one", "first", "second");
      const swapped = await tree("swapped", "second", "first");
      expect(one.root_digest).toEqual({
        algorithm: "rea-directory-tree",
        version: 1,
        status: "complete",
        sha256: directoryTreeDigest([
          { kind: "file", path: "é", sha256: sha("first") },
          { kind: "file", path: "é", sha256: sha("second") },
        ]),
        member_count: 2,
      });
      expect(swapped.root_digest?.status).toBe("complete");
      expect(swapped.manifest.root_sha256).not.toBe(one.manifest.root_sha256);
    },
  );

  it("reports a walk the entry limit stopped as partial, with no digest", async () => {
    const root = await createTestTempDirectory("rea-tree-digest-limit-");
    await writeBuild(root, SPIRV, "forward");
    const complete = await inventory(root);
    const stopped = await inventory(root, {
      maximumEntries: 2,
      maximumBytes: 1 << 20,
    });
    expect(stopped.root_digest).toMatchObject({
      algorithm: "rea-directory-tree",
      version: 1,
      status: "partial",
      limitations: [expect.stringContaining("allowance exhausted")],
    });
    expect(stopped.root_digest).not.toHaveProperty("sha256");
    expect(stopped.manifest.root_sha256).not.toBe(
      complete.manifest.root_sha256,
    );
    expect(stopped.coverage.status).toBe("unknown");
  });
});
