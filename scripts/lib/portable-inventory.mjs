import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open, opendir } from "node:fs/promises";
import { join } from "node:path";

const MAX_PORTABLE_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_PORTABLE_MANIFEST_FILES = 50_000;

/** Read and bound an untrusted portable inventory before using its entries. */
export async function readPortableManifest(path) {
  const file = await open(path, "r");
  let chunks;
  let size = 0;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile())
      throw new Error("Portable manifest must be a regular file.");
    if (metadata.size > MAX_PORTABLE_MANIFEST_BYTES)
      throw new Error("Portable manifest exceeds the 8 MiB limit.");
    chunks = [];
    const buffer = Buffer.alloc(64 * 1024);
    while (size <= MAX_PORTABLE_MANIFEST_BYTES) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, MAX_PORTABLE_MANIFEST_BYTES + 1 - size),
        size,
      );
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      size += bytesRead;
    }
    if (size > MAX_PORTABLE_MANIFEST_BYTES)
      throw new Error("Portable manifest exceeds the 8 MiB limit.");
  } finally {
    await file.close();
  }

  const manifest = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, size),
    ),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !Array.isArray(manifest.files)
  )
    throw new Error("Portable manifest must contain a files array.");
  if (manifest.files.length > MAX_PORTABLE_MANIFEST_FILES)
    throw new Error("Portable manifest exceeds the 50,000-file limit.");
  return manifest;
}

/** Hash one opened file with bounded buffers; reject size mismatches before reads. */
export async function hashPortableFile(path, expectedSize) {
  const file = await open(path, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile())
      throw new Error(
        `Portable inventory contains a non-regular file: ${path}`,
      );
    if (expectedSize !== undefined && metadata.size !== expectedSize)
      throw new Error(
        `Portable file size mismatch: ${path}; expected ${expectedSize}, observed ${metadata.size}`,
      );
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of file.createReadStream({
      autoClose: false,
      highWaterMark: 64 * 1024,
    })) {
      size += chunk.length;
      if (size > metadata.size)
        throw new Error(`Portable file size changed while hashing: ${path}`);
      hash.update(chunk);
    }
    if (size !== metadata.size)
      throw new Error(`Portable file size changed while hashing: ${path}`);
    return { size, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

/** Require exact files and their parent directories before running the artifact. */
export async function verifyPortableInventory(directory, files) {
  const expected = files.map(({ path }) => {
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.includes("//") ||
      path.endsWith("/") ||
      path === "." ||
      path === ".." ||
      path.startsWith("./") ||
      path.startsWith("../") ||
      path.includes("/./") ||
      path.includes("/../") ||
      path.endsWith("/.") ||
      path.endsWith("/..") ||
      (process.platform === "win32" && path.includes(":"))
    )
      throw new Error("Portable inventory contains an invalid relative path.");
    const fullPath = join(directory, path);
    const pathLength =
      process.platform === "win32"
        ? fullPath.length
        : Buffer.byteLength(fullPath);
    const pathLimit = process.platform === "win32" ? 32_767 : 4_096;
    if (pathLength >= pathLimit)
      throw new Error(
        `Portable inventory path exceeds the host path limit: ${path}`,
      );
    return path;
  });
  const expectedSet = new Set(expected);
  if (expectedSet.size !== expected.length)
    throw new Error("Portable inventory contains duplicate file paths.");
  const sortedExpected = [...expectedSet].sort();
  const missing = new Set(expectedSet);
  const hasExpectedDescendant = (prefix) => {
    let lower = 0;
    let upper = sortedExpected.length;
    while (lower < upper) {
      const middle = (lower + upper) >>> 1;
      if ((sortedExpected[middle] ?? "") < prefix) lower = middle + 1;
      else upper = middle;
    }
    return sortedExpected[lower]?.startsWith(prefix) === true;
  };
  // Pending relative paths are disjoint expected subtrees, bounded by the
  // manifest. Close each iterator before descent: depth must not retain parent
  // handles, promise frames or every growing absolute-path prefix.
  const pending = [""];
  while (pending.length > 0) {
    const prefix = pending.pop();
    const directoryEntries = await opendir(join(directory, prefix));
    for await (const entry of directoryEntries) {
      const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        // Even an empty package directory can shadow a hoisted Node dependency.
        if (!hasExpectedDescendant(`${path}/`))
          throw new Error(
            `Portable inventory contains an unlisted directory: ${path}`,
          );
        pending.push(path);
      } else if (!entry.isFile())
        throw new Error(
          `Portable inventory contains a non-regular entry: ${path}`,
        );
      else if (path !== "portable.json" && !missing.delete(path))
        throw new Error(
          `Portable inventory contains an unlisted file: ${path}`,
        );
    }
  }
  assert.equal(
    missing.size,
    0,
    `Portable inventory is missing ${missing.size} expected file(s).`,
  );
}
