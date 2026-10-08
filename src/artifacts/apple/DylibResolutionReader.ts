import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { resolveTreePath } from "../../domain/apple/dyldPaths.js";
import {
  dylibResolutionInputSchema,
  dylibResolutionResultSchema,
  traceDylibLoading,
  type DylibResolutionResult,
  type DylibSharedCacheView,
  type DylibTreeEntry,
  type DylibTreeView,
  type MachoImageFacts,
} from "../../domain/apple/dylibResolution.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import { DirectoryArtifactReader } from "../DirectoryArtifactReader.js";
import { DyldSharedCache } from "./DyldSharedCacheReader.js";
import {
  filesystemDyldLinkTarget,
  filesystemDyldLookupPath,
} from "./FilesystemDyldPaths.js";
import { hasMachoMagic, readMachoImage } from "./MachoLoadCommandReader.js";

const HASH_CHUNK_BYTES = 1024 * 1024;

/** Device, inode, size and change times of the file whose bytes were parsed. */
type FileIdentity = string;

/** Lazily probed, symlink-preserving view of one analyzed directory. */
class FilesystemTreeView implements DylibTreeView {
  readonly #entries = new Map<string, Promise<DylibTreeEntry | undefined>>();
  readonly #images = new Map<string, Promise<MachoImageFacts>>();
  readonly #identities = new Map<string, FileIdentity>();

  constructor(
    private readonly root: string,
    private readonly signal?: AbortSignal,
  ) {}

  entry(path: string): Promise<DylibTreeEntry | undefined> {
    const cached = this.#entries.get(path);
    if (cached !== undefined) return cached;
    const pending = this.#readEntry(path);
    this.#entries.set(path, pending);
    return pending;
  }

  image(path: string): Promise<MachoImageFacts> {
    const cached = this.#images.get(path);
    if (cached !== undefined) return cached;
    const pending = readImage(join(this.root, path), this.signal).then(
      ({ facts, identity }) => {
        this.#identities.set(path, identity);
        return facts;
      },
    );
    this.#images.set(path, pending);
    return pending;
  }

  /** Identity of the file whose header bytes `image()` parsed. */
  identity(path: string): FileIdentity | undefined {
    return this.#identities.get(path);
  }

  async #readEntry(path: string): Promise<DylibTreeEntry | undefined> {
    cancelled(this.signal);
    const absolute = filesystemDyldLookupPath(this.root, path);
    try {
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink())
        return {
          kind: "symlink",
          target: filesystemDyldLinkTarget(await readlink(absolute)),
        };
      if (metadata.isDirectory()) return { kind: "directory" };
      return metadata.isFile() ? { kind: "file" } : undefined;
    } catch (cause: unknown) {
      if (missing(cause)) return undefined;
      throw cause;
    }
  }
}

/** Resolve dyld load paths for the active Mach-O or every executable in its bundle. */
export const traceDylibResolution = async (options: {
  readonly rootPath: string;
  readonly targetPath: string;
  readonly targetSha256: string;
  readonly enumerateRoots: boolean;
  readonly parameters: unknown;
  readonly signal?: AbortSignal;
}): Promise<DylibResolutionResult> => {
  const parsed = dylibResolutionInputSchema.safeParse(options.parameters);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at =
      issue !== undefined && issue.path.length > 0
        ? ` (${issue.path.join(".")} ${issue.message})`
        : "";
    throw new ArtifactReaderFailure(
      "path",
      `dylib resolution parameters are invalid${at}`,
    );
  }
  let cache: DyldSharedCache | undefined;
  // Canonicalization is inside the translated region: a revoked permission
  // keeps its reason and path.
  let root = options.rootPath;
  try {
    root = await realpath(options.rootPath);
    const target = relative(root, await realpath(options.targetPath))
      .split(sep)
      .join("/");
    const view = new FilesystemTreeView(root, options.signal);
    cache = await openSharedCache(parsed.data.shared_cache, options.signal);
    const { roots: requested, unclassified } =
      parsed.data.roots !== undefined
        ? { roots: parsed.data.roots, unclassified: [] }
        : options.enumerateRoots
          ? await executableRoots(root, view, options.signal)
          : { roots: [target], unclassified: [] };
    const roots = await requireMachoRoots(view, requested);
    const trace = await traceDylibLoading(view, {
      roots,
      unclassified,
      ...(parsed.data.architecture === undefined
        ? {}
        : { architecture: parsed.data.architecture }),
      ...(cache === undefined ? {} : { sharedCache: sharedCacheView(cache) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    // Each digest must describe the same file whose headers were parsed.
    const digests = new Map<string, string>();
    for (const { path } of trace.images)
      digests.set(
        path,
        await fileSha256(join(root, path), {
          path,
          expected: view.identity(path),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      );
    const targetDigest =
      digests.get(target) ??
      (await fileSha256(join(root, target), {
        path: target,
        expected: undefined,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }));
    if (targetDigest !== options.targetSha256)
      throw new ArtifactReaderFailure(
        "integrity",
        `Active target digest changed: expected ${options.targetSha256}, observed ${targetDigest}`,
      );
    // Bind the trace to the cache bytes that produced it: a replaced cache
    // can retain header UUID/architecture while changing resolutions.
    const cacheIdentity =
      cache === undefined || parsed.data.shared_cache === undefined
        ? null
        : {
            path: parsed.data.shared_cache,
            uuid: cache.header.uuid,
            architecture: cache.header.architecture,
            os_version: cache.header.os_version,
            main_file_sha256: await cache.mainSha256(options.signal),
            subcache_sha256: await cache.subcacheSha256(options.signal),
          };
    return dylibResolutionResultSchema.parse({
      ...trace,
      root_path: options.rootPath,
      target_sha256: options.targetSha256,
      shared_cache: cacheIdentity,
      images: trace.images.map((image) => ({
        ...image,
        sha256: digests.get(image.path),
      })),
    });
  } catch (cause: unknown) {
    if (options.signal?.aborted === true)
      throw new ArtifactReaderFailure(
        "cancelled",
        "Dylib resolution was cancelled",
        { cause },
      );
    const denied = permissionDenied(cause);
    if (denied !== undefined)
      throw new ArtifactReaderFailure(
        "unavailable",
        `Permission denied (${denied.code}) reading ${deniedPath(root, denied.path)}`,
        { cause },
      );
    throw cause;
  } finally {
    await cache?.close();
  }
};

const openSharedCache = async (
  path: string | undefined,
  signal?: AbortSignal,
): Promise<DyldSharedCache | undefined> => {
  if (path === undefined) return undefined;
  try {
    return await DyldSharedCache.open(resolve(path), signal);
  } catch (cause: unknown) {
    if (missing(cause))
      throw new ArtifactReaderFailure(
        "path",
        "shared_cache does not name an existing dyld shared cache file",
        { cause },
      );
    throw cause;
  }
};

const sharedCacheView = (cache: DyldSharedCache): DylibSharedCacheView => ({
  architecture: cache.header.architecture,
  platforms: [cache.header.platform, cache.header.alt_platform].filter(
    (platform) => platform !== null,
  ),
  unavailableSubcaches: cache.header.subcaches
    .filter(({ status }) => status !== "present")
    .map(({ suffix, status }) => `${suffix} (${status})`),
  lookup: (path) => cache.locate(path),
  image: async (path) => (await cache.imageFacts(path))?.facts,
});

/**
 * Every Mach-O in the bundle with an executable slice is its own process root.
 * Mach-O files that do not parse are returned separately: whether they are
 * executables is unknown, so they make coverage partial instead of vanishing.
 */
const executableRoots = async (
  root: string,
  view: FilesystemTreeView,
  signal?: AbortSignal,
): Promise<{ readonly roots: string[]; readonly unclassified: string[] }> => {
  const roots: string[] = [];
  const unclassified: string[] = [];
  for await (const entry of new DirectoryArtifactReader(root).entries(signal)) {
    if (
      entry.kind !== "file" ||
      !(await startsWithMachoMagic(entry.adapterKey))
    )
      continue;
    const facts = await view.image(entry.path);
    if (facts.status === "malformed" || facts.status === "unsupported")
      unclassified.push(entry.path);
    else if (
      facts.status === "parsed" &&
      facts.slices.some(({ file_type: type }) => type === "execute")
    )
      roots.push(entry.path);
  }
  return {
    roots: roots.sort(compare),
    unclassified: unclassified.sort(compare),
  };
};

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Resolve each root segment by segment, as dependency candidates are, so a
 * symlink in an intermediate directory cannot lead outside the analyzed root.
 */
const requireMachoRoots = async (
  view: FilesystemTreeView,
  roots: readonly string[],
): Promise<string[]> => {
  const resolved: string[] = [];
  for (const path of roots) {
    const lookup = await resolveTreePath(view, path);
    if (lookup.kind === "escapes")
      throw new ArtifactReaderFailure(
        "path",
        `Root ${path} resolves outside the analyzed root`,
      );
    if (lookup.kind !== "file")
      throw new ArtifactReaderFailure(
        "path",
        `Root ${path} is not a regular file in the analyzed root`,
      );
    if ((await view.image(lookup.path)).status === "not-mach-o")
      throw new ArtifactReaderFailure(
        "format",
        `Root ${path} is not a Mach-O image`,
      );
    if (!resolved.includes(lookup.path)) resolved.push(lookup.path);
  }
  return resolved;
};

const startsWithMachoMagic = async (path: string): Promise<boolean> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = new Uint8Array(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    return hasMachoMagic(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
};

const identityOf = (metadata: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}): FileIdentity =>
  [
    metadata.dev,
    metadata.ino,
    metadata.size,
    metadata.mtimeNs,
    metadata.ctimeNs,
  ].join(":");

const readImage = async (
  path: string,
  signal?: AbortSignal,
): Promise<{
  readonly facts: MachoImageFacts;
  readonly identity: FileIdentity;
}> => {
  cancelled(signal);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat({ bigint: true });
    const size = Number(metadata.size);
    const facts = await readMachoImage(async (offset, length) => {
      cancelled(signal);
      const buffer = new Uint8Array(
        Math.max(0, Math.min(length, size - offset)),
      );
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return buffer.subarray(0, bytesRead);
    }, size);
    return { facts, identity: identityOf(metadata) };
  } finally {
    await handle.close();
  }
};

/** Hash a file, failing if it is not the file (or the version) that was parsed. */
const fileSha256 = async (
  absolute: string,
  options: {
    readonly path: string;
    readonly expected: FileIdentity | undefined;
    readonly signal?: AbortSignal;
  },
): Promise<string> => {
  const { signal } = options;
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const unchanged = async (): Promise<void> => {
    if (
      options.expected !== undefined &&
      identityOf(await handle.stat({ bigint: true })) !== options.expected
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `${options.path} changed while its dyld load commands were traced`,
      );
  };
  try {
    await unchanged();
    const hash = createHash("sha256");
    const buffer = new Uint8Array(HASH_CHUNK_BYTES);
    for (;;) {
      cancelled(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    await unchanged();
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
};

const cancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "Dylib resolution was cancelled",
    );
};

/** A denied path relative to the analyzed root, or absolute when outside it. */
const deniedPath = (root: string, path: string | undefined): string => {
  if (path === undefined) return "a file in the analyzed root";
  const inside = relative(root, path);
  return inside === "" || inside.startsWith("..") ? path : inside;
};

/** Host permission denials, kept distinct from malformed or missing files. */
const permissionDenied = (
  cause: unknown,
): { readonly code: string; readonly path: string | undefined } | undefined => {
  if (!(cause instanceof Error) || !("code" in cause)) return undefined;
  if (cause.code !== "EACCES" && cause.code !== "EPERM") return undefined;
  return {
    code: cause.code,
    path:
      "path" in cause && typeof cause.path === "string"
        ? cause.path
        : undefined,
  };
};

const missing = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR");
