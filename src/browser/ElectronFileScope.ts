import type { Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { getRawHeader } from "@electron/asar";

/** Resolve one local file URL while rejecting remote hosts and encoded separators. */
export const authorizedElectronFile = async (
  value: string,
): Promise<string | undefined> => {
  if (/%(?:2f|5c)/iu.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause: unknown) {
    // Non-URL input cannot authorize a local file.
    void cause;
    return undefined;
  }
  if (
    url.protocol !== "file:" ||
    url.hostname !== "" ||
    url.username !== "" ||
    url.password !== ""
  )
    return undefined;
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch (cause: unknown) {
    // Unconvertible file URLs cannot authorize a local file.
    void cause;
    return undefined;
  }
  if (!isAbsolute(path) || path.includes("\0")) return undefined;
  try {
    if ((await stat(path)).isFile()) return await realpath(path);
  } catch (cause: unknown) {
    // Electron serves packaged pages from inside app.asar, which the host
    // filesystem cannot stat; resolve those through the archive header below.
    void cause;
  }
  return await authorizedAsarMember(path);
};

/**
 * Resolve `<archive>.asar/<member>` the way Electron's file protocol does: the
 * first `.asar` path component that is a regular file is the archive, and the
 * remainder must name a regular file in its header (packed or unpacked).
 */
const authorizedAsarMember = async (
  path: string,
): Promise<string | undefined> => {
  const segments = path.split(sep);
  for (let index = 1; index < segments.length - 1; index += 1) {
    if (!(segments[index] ?? "").toLowerCase().endsWith(".asar")) continue;
    const archive = segments.slice(0, index + 1).join(sep);
    const member = segments.slice(index + 1);
    if (member.some((part) => part === "" || part === "." || part === ".."))
      return undefined;
    try {
      const metadata = await stat(archive);
      if (!metadata.isFile()) return undefined;
      const canonical = await realpath(archive);
      const files = asarFiles(canonical, metadata);
      return isAsarRegularFile(files, member)
        ? join(canonical, ...member)
        : undefined;
    } catch (cause: unknown) {
      // An unreadable or malformed archive cannot authorize its members.
      void cause;
      return undefined;
    }
  }
  return undefined;
};

type ArchiveIdentity = Pick<Stats, "dev" | "ino" | "size" | "mtimeMs">;

const MAX_CACHED_HEADERS = 8;
const headerCache = new Map<
  string,
  { readonly identity: string; readonly files: unknown }
>();

/** Parse each archive header once per observed file identity. */
const asarFiles = (archive: string, metadata: ArchiveIdentity): unknown => {
  const identity = `${String(metadata.dev)}:${String(metadata.ino)}:${String(metadata.size)}:${String(metadata.mtimeMs)}`;
  const cached = headerCache.get(archive);
  if (cached?.identity === identity) return cached.files;
  const files: unknown = getRawHeader(archive).header.files;
  headerCache.delete(archive);
  headerCache.set(archive, { identity, files });
  if (headerCache.size > MAX_CACHED_HEADERS)
    headerCache.delete(headerCache.keys().next().value ?? archive);
  return files;
};

const isAsarRegularFile = (
  files: unknown,
  member: readonly string[],
): boolean => {
  let node: unknown = { files };
  for (const part of member) {
    const children = isRecord(node) ? node.files : undefined;
    if (!isRecord(children) || !Object.hasOwn(children, part)) return false;
    node = children[part];
  }
  return (
    isRecord(node) &&
    typeof node.size === "number" &&
    !("files" in node) &&
    !("link" in node)
  );
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
