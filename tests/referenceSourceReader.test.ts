import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readReferenceSource } from "../src/reference/ReferenceSourceReader.js";

const limits = {
  maxBytes: 1_024,
  maxEntries: 10,
  maxDepth: 4,
  maxPathBytes: 100,
} as const;

describe("readReferenceSource", () => {
  it("returns explicit entries in canonical code-point path order", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-reference-"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "z.js"), "z");
    await writeFile(join(root, "a.js"), "a");
    await writeFile(join(root, "nested", "b.js"), "b");
    await writeFile(join(root, "\u{e000}"), "p");
    await writeFile(join(root, "\u{10000}"), "a");

    const result = await readReferenceSource(root, limits);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map(({ path }) => path)).toEqual([
      "a.js",
      "nested",
      "nested/b.js",
      "z.js",
      "",
      "𐀀",
    ]);
    expect(result.value.bytesRead).toBe(5);
    expect(result.value.truncated).toBe(false);
    expect(
      result.value.entries.map((entry) =>
        entry.status === "read" && entry.kind === "file"
          ? Buffer.from(entry.bytes).toString()
          : entry.status === "read"
            ? entry.kind
            : entry.code,
      ),
    ).toEqual(["a", "directory", "b", "z", "p", "a"]);
    expect(result.value.limitations).toHaveLength(1);
  });

  it("sanitizes internal, external, and missing symlink targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-reference-"));
    const outside = await mkdtemp(join(tmpdir(), "rea-outside-"));
    await writeFile(join(outside, "secret"), "secret");
    await writeFile(join(root, "local"), "local");
    await symlink("local", join(root, "internal"));
    await symlink(join(outside, "secret"), join(root, "external"));
    await symlink("absent", join(root, "missing"));

    const result = await readReferenceSource(root, limits);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries).toEqual([
      {
        status: "read",
        kind: "symlink",
        path: "external",
        target: "<outside-root>",
        targetState: "external",
      },
      {
        status: "read",
        kind: "symlink",
        path: "internal",
        target: "local",
        targetState: "internal",
      },
      {
        status: "read",
        kind: "file",
        path: "local",
        bytes: expect.any(Uint8Array),
        size: 5,
      },
      {
        status: "read",
        kind: "symlink",
        path: "missing",
        target: "absent",
        targetState: "missing",
      },
    ]);
    expect(result.value.bytesRead).toBe(5);
    expect(JSON.stringify(result.value.entries)).not.toContain(outside);
  });

  it("makes byte, file, depth, and path limits explicit per entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-reference-"));
    await writeFile(join(root, "a"), "too large");
    await writeFile(join(root, "b"), "b");
    await mkdir(join(root, "deep"));
    await writeFile(join(root, "deep", "c"), "c");

    const result = await readReferenceSource(root, {
      maxBytes: 1,
      maxEntries: 1,
      maxDepth: 1,
      maxPathBytes: 4,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncated).toBe(true);
    expect(result.value.entries).toEqual([
      expect.objectContaining({
        path: "a",
        kind: "file",
        status: "failed",
        code: "limit",
        size: 9,
      }),
    ]);
    expect(result.value.limitations).toContain(
      "Traversal stopped because the entry limit was reached.",
    );
    expect(result.value.entries).not.toContainEqual(
      expect.objectContaining({ path: "<tree>" }),
    );
  });

  it("applies maxEntries as a global limit across every entry kind", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-reference-"));
    await writeFile(join(root, "a"), "a");
    await writeFile(join(root, "b"), "b");
    await writeFile(join(root, "c"), "c");

    const result = await readReferenceSource(root, {
      ...limits,
      maxEntries: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map(({ path }) => path)).toEqual(["a"]);
    expect(result.value.bytesRead).toBe(1);
    expect(result.value.truncated).toBe(true);
  });

  it("applies exclusions to normalized paths before reading entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-reference-"));
    await mkdir(join(root, "ignored"));
    await writeFile(join(root, "ignored", "secret"), "secret");
    await writeFile(join(root, "kept"), "kept");
    const checked: string[] = [];

    const result = await readReferenceSource(root, limits, {
      shouldExclude: (path) => {
        checked.push(path);
        return path === "ignored";
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(checked).toEqual(["ignored", "kept"]);
    expect(result.value.entries.map(({ path }) => path)).toEqual(["kept"]);
  });

  it("sanitizes exclusion callback failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-reference-"));
    await writeFile(join(root, "file"), "value");
    const result = await readReferenceSource(root, limits, {
      shouldExclude: () => {
        throw new Error("private callback detail");
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        tag: "reference-source-reader",
        code: "io",
        message: "Reference source exclusion check failed",
      },
    });
  });

  it("sanitizes filesystem errors", async () => {
    const missing = join(tmpdir(), "rea-secret-root-that-does-not-exist");
    const result = await readReferenceSource(missing, limits);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe(
      "Reference source root could not be resolved",
    );
    expect(result.error.message).not.toContain(missing);
  });

  it("returns typed failures for cancellation and invalid roots", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = await readReferenceSource("/unused", limits, {
      signal: controller.signal,
    });
    expect(cancelled).toEqual({
      ok: false,
      error: {
        tag: "reference-source-reader",
        code: "cancelled",
        message: "Reference source traversal cancelled",
      },
    });

    const invalid = await readReferenceSource(
      "/path/that/does/not/exist",
      limits,
    );
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error.code).toBe("invalid-root");
  });
});
