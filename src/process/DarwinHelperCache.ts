import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { release } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { safeParseJson } from "../domain/safeJson.js";
import { appendCallerPath } from "../filesystem/callerPath.js";
import type { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { withOwnedRegularFile } from "../filesystem/OwnedRegularFile.js";
import { readStableFileBytes } from "../filesystem/readStableFileBytes.js";
import { execFileOutput } from "./ExecFileOutput.js";

/** Bumped when the entry layout or the key material changes meaning. */
const CACHE_FORMAT = 2;
const HELPER_NAME = "reader";
const MANIFEST_NAME = "manifest.json";
const MAX_MANIFEST_BYTES = 4096;
// The compiled helper is about 240 KiB; refuse to hash anything far larger.
const MAX_HELPER_BYTES = 16 * 1024 * 1024;
// xcrun answers a lookup in milliseconds; a stalled one only forgoes reuse.
const TOOLCHAIN_LOOKUP_TIMEOUT_MS = 15_000;

const manifestSchema = z.strictObject({
  format: z.literal(CACHE_FORMAT),
  key: z.string().regex(/^[a-f0-9]{64}$/u),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.int().positive(),
});

// Sticky directories let only an entry's owner rename or remove it.
const STICKY = 0o1000;

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

/** Per-user namespace REA owns for the compiled Darwin ownership helper. */
export const defaultDarwinHelperCacheDirectory = (home: string): string =>
  appendCallerPath(home, "Library/Caches/rea/process-helper", "darwin");

/**
 * Only the default toolchain shares a helper: a caller-selected compiler or
 * module cache keeps every helper write inside the boundary the caller chose.
 */
export const darwinHelperCacheDirectory = (selection: {
  readonly home: string | undefined;
  readonly compilerSelected: boolean;
  readonly moduleCachePath: string | undefined;
}): string | undefined =>
  selection.compilerSelected ||
  (selection.moduleCachePath ?? "") !== "" ||
  selection.home === undefined ||
  !isAbsolute(selection.home)
    ? undefined
    : defaultDarwinHelperCacheDirectory(selection.home);

/** Only the current user may have written an entry REA will execute. */
const privatelyOwned = (stats: Stats, uid: number): boolean =>
  stats.uid === uid && (stats.mode & 0o022) === 0;

/**
 * No other user can rename an entry on the path: each real ancestor belongs
 * to this user or root and is not writable by others, unless it is a sticky
 * root-owned directory, where only an entry's owner may rename it.
 */
const ancestorsTrusted = async (
  path: string,
  uid: number,
): Promise<boolean> => {
  for (let current = path; ; current = dirname(current)) {
    const stats = await lstat(current);
    if (!stats.isDirectory() || (stats.uid !== uid && stats.uid !== 0))
      return false;
    if (
      (stats.mode & 0o022) !== 0 &&
      !(stats.uid === 0 && (stats.mode & STICKY) !== 0)
    )
      return false;
    if (dirname(current) === current) return true;
  }
};

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

/** Identity of a file whose bytes shape the compiled helper. */
const fileIdentity = async (path: string) => {
  const real = await realpath(path);
  const facts = await stat(real);
  return { path: real, size: facts.size, mtime_ms: facts.mtimeMs };
};

/** Result of looking up the helper for this exact source and toolchain. */
export type DarwinHelperLookup =
  | { readonly kind: "hit"; readonly executable: string }
  | { readonly kind: "miss"; readonly key: string }
  | { readonly kind: "unavailable" };

/**
 * Content-addressed reuse of the compiled ownership helper across REA
 * processes. Every failure falls back to the per-process compile: the cache
 * never fails an ownership operation and never executes an entry that is not
 * a private, current-user, digest-verified copy for this key. A published
 * entry is never replaced, so a running reader's helper path stays valid.
 * Same-user tampering is outside this boundary, as it is for the per-process
 * helper.
 */
export const createDarwinHelperCache = (options: {
  readonly directory: string;
  readonly sources: readonly string[];
  /** The xcrun that resolves the toolchain the compile will use. */
  readonly xcrun: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}) => {
  const uid = process.getuid?.();
  // Failed closes and removals stay owned until close() retries them.
  const retained = new Map<string, () => Promise<void>>();
  // The first unresolved close failure; later ones depend on it.
  let cleanupAnchor: ProviderCleanupError | undefined;
  let key: Promise<string> | undefined;

  const xcrun = async (
    arguments_: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    const { stdout } = await execFileOutput(options.xcrun, arguments_, {
      env: options.environment,
      timeout: TOOLCHAIN_LOOKUP_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      stopSignal: "SIGTERM",
      ...(signal === undefined ? {} : { signal }),
    });
    const path = stdout.trim();
    if (!isAbsolute(path))
      throw new Error(`xcrun ${arguments_.join(" ")} returned no path`);
    return path;
  };

  /** Wait for every started read before reporting the first failure. */
  const settleAll = async <Values extends readonly unknown[]>(pending: {
    readonly [Index in keyof Values]: Promise<Values[Index]>;
  }): Promise<Values> => {
    await Promise.allSettled(pending);
    return Promise.all(pending) as Promise<Values>;
  };

  /** xcrun owns toolchain selection; key on what it resolves. */
  const computeKey = async (signal: AbortSignal | undefined) => {
    const [sources, compilerPath, sdkPath] = await settleAll<
      [string[], string, string]
    >([
      Promise.all(
        options.sources.map(async (source) => sha256(await readFile(source))),
      ),
      xcrun(["--find", "swiftc"], signal),
      xcrun(["--show-sdk-path"], signal),
    ]);
    const [compiler, sdk] = await settleAll<
      [
        Awaited<ReturnType<typeof fileIdentity>>,
        Awaited<ReturnType<typeof fileIdentity>>,
      ]
    >([
      fileIdentity(compilerPath),
      fileIdentity(join(sdkPath, "SDKSettings.json")),
    ]);
    return sha256(
      JSON.stringify({
        format: CACHE_FORMAT,
        sources,
        compiler,
        sdk,
        architecture: process.arch,
        os_release: release(),
      }),
    );
  };

  /** A cancelled or failed key computation is retried by the next lookup. */
  const cacheKey = (signal: AbortSignal | undefined): Promise<string> => {
    if (key !== undefined) return key;
    const pending = computeKey(signal);
    key = pending;
    pending.catch(() => {
      if (key === pending) key = undefined;
    });
    return pending;
  };

  /** The real cache root, created privately, with only trusted ancestors. */
  const trustedRoot = async (owner: number): Promise<string | undefined> => {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const named = await lstat(options.directory);
    if (!named.isDirectory() || !privatelyOwned(named, owner)) return undefined;
    const root = await realpath(options.directory);
    return (await ancestorsTrusted(root, owner)) ? root : undefined;
  };

  const retainClose = (owner: OwnedFileHandle): void => {
    retained.set(`file handle ${String(owner.handle.fd)}`, () => owner.close());
  };

  /** Hash the opened descriptor itself; FIFOs and links never block or pass. */
  const readEntryFile = (
    path: string,
    owner: number,
    maximumBytes: number,
    executable: boolean,
  ): Promise<Buffer | undefined> =>
    withOwnedRegularFile(
      path,
      { symlinks: "reject", retainFailedClose: retainClose },
      async ({ handle, initial }) =>
        !privatelyOwned(initial, owner) ||
        (executable && (initial.mode & 0o100) === 0) ||
        initial.size === 0 ||
        initial.size > maximumBytes
          ? undefined
          : readStableFileBytes(handle, path, maximumBytes, {
              symlinks: "reject",
            }),
    ).catch(() => undefined);

  const verifiedHelper = async (
    entry: string,
    entryKey: string,
    owner: number,
  ): Promise<string | undefined> => {
    const manifestBytes = await readEntryFile(
      join(entry, MANIFEST_NAME),
      owner,
      MAX_MANIFEST_BYTES,
      false,
    );
    const decoded =
      manifestBytes === undefined
        ? undefined
        : safeParseJson(manifestBytes.toString("utf8"));
    const manifest =
      decoded?.ok === true
        ? manifestSchema.safeParse(decoded.value)
        : undefined;
    if (manifest?.success !== true || manifest.data.key !== entryKey)
      return undefined;
    const executable = join(entry, HELPER_NAME);
    const helper = await readEntryFile(
      executable,
      owner,
      MAX_HELPER_BYTES,
      true,
    );
    return helper !== undefined &&
      helper.byteLength === manifest.data.size &&
      sha256(helper) === manifest.data.sha256
      ? executable
      : undefined;
  };

  const lookup = async (signal?: AbortSignal): Promise<DarwinHelperLookup> => {
    if (uid === undefined) return { kind: "unavailable" };
    try {
      const root = await trustedRoot(uid);
      if (root === undefined) return { kind: "unavailable" };
      const entryKey = await cacheKey(signal);
      const entry = join(root, entryKey);
      let entryStats: Stats;
      try {
        entryStats = await lstat(entry);
      } catch (cause: unknown) {
        if (isMissing(cause)) return { kind: "miss", key: entryKey };
        throw cause;
      }
      // An invalid entry is left in place: removing it could race another
      // process that has just verified or published that path.
      if (!entryStats.isDirectory() || !privatelyOwned(entryStats, uid))
        return { kind: "unavailable" };
      const executable = await verifiedHelper(entry, entryKey, uid);
      return executable === undefined
        ? { kind: "unavailable" }
        : { kind: "hit", executable };
    } catch {
      return { kind: "unavailable" };
    }
  };

  const removeStaging = async (path: string): Promise<void> => {
    const remove = () => rm(path, { recursive: true, force: true });
    await remove().catch(() => {
      retained.set(path, remove);
    });
  };

  /**
   * Atomically publish a verified copy and return the shared helper to run.
   * macOS assesses each new executable file on its first launch (about 0.3 s),
   * so running the shared copy pays that once for every later process.
   */
  const publish = async (
    entryKey: string,
    compiled: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    if (uid === undefined) return undefined;
    let staging: string | undefined;
    try {
      const root = await trustedRoot(uid);
      if (root === undefined) return undefined;
      staging = await mkdtemp(join(root, ".publish-"));
      const copied = join(staging, HELPER_NAME);
      await copyFile(compiled, copied, constants.COPYFILE_EXCL);
      await chmod(copied, 0o700);
      const helper = await readEntryFile(copied, uid, MAX_HELPER_BYTES, true);
      if (helper === undefined) return undefined;
      await writeFile(
        join(staging, MANIFEST_NAME),
        JSON.stringify({
          format: CACHE_FORMAT,
          key: entryKey,
          sha256: sha256(helper),
          size: helper.byteLength,
        }),
        { mode: 0o600, flag: "wx" },
      );
      const entry = join(root, entryKey);
      try {
        await rename(staging, entry);
        staging = undefined;
        return join(entry, HELPER_NAME);
      } catch {
        // A concurrent publisher won; run its entry only once it verifies.
        const winner = await lookup(signal);
        return winner.kind === "hit" ? winner.executable : undefined;
      }
    } catch {
      // Publication is an optimization; the caller keeps its own helper.
      return undefined;
    } finally {
      if (staging !== undefined) await removeStaging(staging);
    }
  };

  /** Retry every retained close or removal; unresolved ones stay owned. */
  const close = async (): Promise<void> => {
    const failed: string[] = [];
    // Deleting the visited entry while iterating a Map is well defined.
    for (const [resource, cleanup] of retained) {
      try {
        await cleanup();
        retained.delete(resource);
      } catch {
        failed.push(resource);
      }
    }
    if (failed.length > 0) {
      const failure = new ProviderCleanupError(
        "process-ownership",
        failed,
        {
          reason:
            "Darwin ownership-helper cache resources remain owned until cleanup succeeds.",
        },
        { operation: "prepare_owned_process" },
      );
      // Every returned failure clears once a later retry releases them all.
      if (cleanupAnchor === undefined) cleanupAnchor = failure;
      else failure.bindCleanupDependencies([cleanupAnchor]);
      throw failure;
    }
    cleanupAnchor?.resolveCleanup();
    cleanupAnchor = undefined;
  };

  return { lookup, publish, close };
};

export type DarwinHelperCache = ReturnType<typeof createDarwinHelperCache>;
