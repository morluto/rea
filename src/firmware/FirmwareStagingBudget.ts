import { lstat, readdir } from "node:fs/promises";
import { sep } from "node:path";
import type { FirmwareDeadline } from "./FirmwareDeadline.js";
import {
  firmwareFileSizeLimitReached,
  firmwareStagingLimit,
  throwIfFirmwareInventoryCancelled,
} from "./FirmwareFiles.js";

const STAGING_STAT_CONCURRENCY = 64;
const SEP_BYTES = Buffer.from(sep);

const joinRawPath = (directory: Buffer, name: Uint8Array): Buffer =>
  directory.subarray(directory.length - SEP_BYTES.length).equals(SEP_BYTES)
    ? Buffer.concat([directory, name])
    : Buffer.concat([directory, SEP_BYTES, name]);

const optionalLstat = async (path: Buffer) =>
  lstat(path).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  });

const optionalReaddirBufferTypes = async (directory: Buffer) =>
  readdir(directory, {
    encoding: "buffer",
    withFileTypes: true,
  }).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  });

/** Parameters for lightweight staging-budget verification while extraction runs. */
export interface FirmwareStagingBudgetCheck {
  readonly root: string;
  readonly maxBytes: number;
  readonly maxEntries: number;
  readonly fileSizeBytes: number;
  readonly operation: string;
  readonly signal?: AbortSignal | undefined;
  readonly deadline?: FirmwareDeadline | undefined;
}

/** Observed entry count and regular-file bytes in the staging directory. */
export interface FirmwareStagingUsage {
  readonly bytes: number;
  readonly entries: number;
}

const flushStagingBudgetStats = async (
  batch: readonly Buffer[],
  pending: Buffer[],
  state: { bytes: number },
  options: FirmwareStagingBudgetCheck,
): Promise<void> => {
  throwIfFirmwareInventoryCancelled(
    options.signal,
    options.operation,
    options.deadline,
  );
  const stats = await Promise.all(batch.map(optionalLstat));
  for (const [index, stat] of stats.entries()) {
    if (stat === undefined) continue;
    if (stat.isDirectory()) {
      const candidate = batch[index];
      if (candidate !== undefined) pending.push(candidate);
      continue;
    }
    if (stat.isFile()) state.bytes += stat.size;
    if (state.bytes > options.maxBytes)
      throw firmwareStagingLimit(
        options.operation,
        "max_output_bytes",
        options.maxBytes,
      );
    if (stat.isFile() && stat.size >= options.fileSizeBytes)
      throw firmwareFileSizeLimitReached(
        options.operation,
        options.fileSizeBytes,
      );
  }
};

/**
 * Lightweight staging-budget check used during command execution: counts
 * entries and regular-file bytes without decoding names, sorting, or reading
 * symlink targets.
 */
export const checkFirmwareStagingBudget = async (
  options: FirmwareStagingBudgetCheck,
): Promise<FirmwareStagingUsage> => {
  const { maxEntries, operation, signal, deadline } = options;
  const pending: Buffer[] = [Buffer.from(options.root)];
  const state = { bytes: 0 };
  let count = 0;
  while (pending.length > 0) {
    throwIfFirmwareInventoryCancelled(signal, operation, deadline);
    const directory = pending.pop();
    if (directory === undefined) break;
    const directoryStat = await optionalLstat(directory);
    if (
      directoryStat === undefined ||
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink()
    )
      continue;
    const entries = await optionalReaddirBufferTypes(directory);
    if (entries === undefined) continue;
    let statBatch: Buffer[] = [];
    for (const entry of entries) {
      throwIfFirmwareInventoryCancelled(signal, operation, deadline);
      count += 1;
      if (count > maxEntries)
        throw firmwareStagingLimit(operation, "max_output_files", maxEntries);
      if (entry.isSymbolicLink()) continue;
      const entryPath = joinRawPath(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      statBatch.push(entryPath);
      if (statBatch.length >= STAGING_STAT_CONCURRENCY) {
        await flushStagingBudgetStats(statBatch, pending, state, options);
        statBatch = [];
      }
    }
    if (statBatch.length > 0)
      await flushStagingBudgetStats(statBatch, pending, state, options);
  }
  return { bytes: state.bytes, entries: count };
};
