import { mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import {
  hashPortableFile,
  readPortableManifest,
  verifyPortableInventory,
} from "../../scripts/lib/portable-inventory.mjs";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, opendir: vi.fn(actual.opendir) };
});

async function fixture() {
  const root = await createTestTempDirectory("rea-portable-inventory-");
  await mkdir(join(root, "runtime"));
  await writeFile(join(root, "runtime/node.exe"), "controlled fixture");
  await writeFile(join(root, "portable.json"), "{}");
  return { root, files: [{ path: "runtime/node.exe" }] };
}

it("hashes an empty file and the final partial stream chunk", async () => {
  const { root } = await fixture();
  const path = join(root, "payload");
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(64 * 1024 + 17, 0x62)]) {
    await writeFile(path, bytes);
    await expect(hashPortableFile(path, bytes.length)).resolves.toEqual({
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
});

it("rejects an unexpected file size", async () => {
  const { root } = await fixture();
  const path = join(root, "payload");
  await writeFile(path, "unexpected payload");
  await expect(hashPortableFile(path, 1)).rejects.toThrow(
    "Portable file size mismatch",
  );
  await unlink(path);
});

it("bounds portable manifest bytes and file entries before inventory work", async () => {
  const { root } = await fixture();
  const path = join(root, "portable.json");
  await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1));
  await expect(readPortableManifest(path)).rejects.toThrow(
    "exceeds the 8 MiB limit",
  );
  await writeFile(path, JSON.stringify({ files: Array(50_001).fill({}) }));
  await expect(readPortableManifest(path)).rejects.toThrow(
    "exceeds the 50,000-file limit",
  );
});

it("accepts the complete regular-file set excluding its own manifest", async () => {
  const { root, files } = await fixture();
  await expect(verifyPortableInventory(root, files)).resolves.toBeUndefined();
});

it("rejects an unlisted nested dependency", async () => {
  const { root, files } = await fixture();
  const stale = join(root, "app/node_modules/stale/node_modules/shadow");
  await mkdir(stale, { recursive: true });
  await writeFile(join(stale, "index.js"), "stale dependency");
  await expect(verifyPortableInventory(root, files)).rejects.toThrow(
    "unlisted directory",
  );
});

it("rejects an unlisted file inside a listed directory", async () => {
  const { root, files } = await fixture();
  await writeFile(join(root, "runtime/stale.dll"), "stale native dependency");
  await expect(verifyPortableInventory(root, files)).rejects.toThrow(
    "unlisted file: runtime/stale.dll",
  );
});

it("rejects an empty nested package directory that can shadow a locked dependency", async () => {
  const { root, files } = await fixture();
  const listed = ["app/node_modules/a/index.js", "app/node_modules/b/index.js"];
  for (const path of listed) {
    const parts = path.split("/");
    await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(root, path), "controlled dependency");
  }
  const inventory = [...files, ...listed.map((path) => ({ path }))];
  await expect(
    verifyPortableInventory(root, inventory),
  ).resolves.toBeUndefined();
  await mkdir(join(root, "app/node_modules/a/node_modules/b"), {
    recursive: true,
  });
  await expect(verifyPortableInventory(root, inventory)).rejects.toThrow(
    "unlisted directory",
  );
});

it("rejects an omitted runtime and duplicate inventory entries", async () => {
  const { root, files } = await fixture();
  await expect(verifyPortableInventory(root, [])).rejects.toThrow(
    "unlisted directory: runtime",
  );
  await expect(
    verifyPortableInventory(root, [...files, ...files]),
  ).rejects.toThrow("duplicate file paths");
});

it("rejects a manifest path beyond the host file-system path limit before traversal", async () => {
  const { root } = await fixture();
  const path = `${"segment/".repeat(5_000)}file.js`;
  await expect(verifyPortableInventory(root, [{ path }])).rejects.toThrow(
    "exceeds the host path limit",
  );
});

it("closes directory handles before descent and after rejecting a deep stale file", async () => {
  const root = await createTestTempDirectory("rea-portable-deep-");
  const path = `${"a/".repeat(128)}file.js`;
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), "controlled fixture");
  const original = (
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  ).opendir;
  let active = 0;
  let peak = 0;
  const opened = vi
    .spyOn(fsPromises, "opendir")
    .mockImplementation(async (...args) => {
      const handle = await original(...args);
      active++;
      peak = Math.max(peak, active);
      const iterator = handle[Symbol.asyncIterator]();
      handle[Symbol.asyncIterator] = async function* () {
        try {
          return yield* iterator;
        } finally {
          active--;
        }
      };
      return handle;
    });
  try {
    await expect(
      verifyPortableInventory(root, [{ path }]),
    ).resolves.toBeUndefined();
    expect(active).toBe(0);
    expect(peak).toBe(1);
    await writeFile(join(root, path, "..", "stale.dll"), "stale dependency");
    await expect(verifyPortableInventory(root, [{ path }])).rejects.toThrow(
      "unlisted file",
    );
    expect(active).toBe(0);
  } finally {
    opened.mockRestore();
  }
});

it("rejects directory links instead of following unlisted contents", async () => {
  const { root, files } = await fixture();
  await symlink(join(root, "runtime"), join(root, "linked"), "junction");
  await expect(verifyPortableInventory(root, files)).rejects.toThrow(
    "non-regular entry: linked",
  );
});
