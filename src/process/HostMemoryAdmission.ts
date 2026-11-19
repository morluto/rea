import { readFile } from "node:fs/promises";
import os from "node:os";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import {
  readLinuxCgroupAdmissionFacts,
  type LinuxCgroupAdmissionFacts,
} from "./LinuxCgroupMemory.js";

/** Facts used to decide whether a memory-heavy launch fits host and cgroup limits. */
export interface HostMemoryAdmissionFacts {
  /** Bytes available on the host after reclaimable cache (Linux) or `os.freemem()`. */
  readonly hostAvailableBytes: number;
  /** Tightest finite cgroup `memory.max`, or null when unlimited/unknown. */
  readonly cgroupMaxBytes: number | null;
  /** Current cgroup charge in bytes, or null when unknown. */
  readonly cgroupUsageBytes: number | null;
}

/** Admission decision for a memory-heavy launch. */
export type MemoryAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: string };

const formatMib = (bytes: number): string =>
  `${Math.round(bytes / (1024 * 1024))} MiB`;

/** Parse memory strings like '2G', '2048M', '512k' into exact bytes. */
export const parseMemorySizeBytes = (
  value: string | undefined,
  defaultBytes = 2 * 1024 * 1024 * 1024,
): number => {
  if (value === undefined || value.trim() === "") return defaultBytes;
  const match = /^(\d+)\s*([kmgtKMGT])?[bB]?$/u.exec(value.trim());
  if (!match?.[1]) return defaultBytes;
  const num = Number.parseInt(match[1], 10);
  if (Number.isNaN(num)) return defaultBytes;
  switch (match[2]?.toUpperCase()) {
    case "K":
      return num * 1024;
    case "M":
      return num * 1024 * 1024;
    case "G":
      return num * 1024 * 1024 * 1024;
    case "T":
      return num * 1024 * 1024 * 1024 * 1024;
    default:
      return num;
  }
};

/** Parse `/proc/meminfo` into available bytes, preferring MemAvailable. */
const parseMeminfoAvailable = (content: string): number | undefined => {
  let memAvailable: number | undefined;
  let memFree = 0;
  let buffers = 0;
  let cached = 0;
  for (const line of content.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const match = /^(\d+)(?:\s+kB)?$/u.exec(line.slice(colon + 1).trim());
    if (match?.[1] === undefined) continue;
    const bytes = Number.parseInt(match[1], 10) * 1024;
    if (key === "MemAvailable") memAvailable = bytes;
    else if (key === "MemFree") memFree = bytes;
    else if (key === "Buffers") buffers = bytes;
    else if (key === "Cached") cached = bytes;
  }
  if (memAvailable !== undefined) return memAvailable;
  const fallback = memFree + buffers + cached;
  return fallback > 0 ? fallback : undefined;
};

/** Host availability honoring Linux reclaimable cache; `os.freemem()` elsewhere. */
export const readHostAvailableBytes = async (
  options: {
    readonly platform?: NodeJS.Platform;
    readonly meminfoPath?: string;
  } = {},
): Promise<number> => {
  const platform = options.platform ?? HOST_PLATFORM.platform;
  if (platform === "linux" || options.meminfoPath !== undefined) {
    try {
      const content = await readFile(
        options.meminfoPath ?? "/proc/meminfo",
        "utf8",
      );
      const available = parseMeminfoAvailable(content);
      if (available !== undefined) return available;
    } catch {
      // Fall through to os.freemem when meminfo is unavailable.
    }
  }
  return os.freemem();
};

/** Read host and cgroup facts for launch admission. */
export const readHostMemoryAdmissionFacts = async (
  options: {
    readonly platform?: NodeJS.Platform;
    readonly meminfoPath?: string;
    readonly procCgroupPath?: string;
    readonly procMountInfoPath?: string;
    readonly readCgroup?: () => Promise<LinuxCgroupAdmissionFacts | undefined>;
  } = {},
): Promise<HostMemoryAdmissionFacts> => {
  const hostAvailableBytes = await readHostAvailableBytes({
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.meminfoPath === undefined
      ? {}
      : { meminfoPath: options.meminfoPath }),
  });
  const cgroup =
    options.readCgroup !== undefined
      ? await options.readCgroup()
      : await readLinuxCgroupAdmissionFacts({
          ...(options.platform === undefined
            ? {}
            : { platform: options.platform }),
          ...(options.procCgroupPath === undefined
            ? {}
            : { procCgroupPath: options.procCgroupPath }),
          ...(options.procMountInfoPath === undefined
            ? {}
            : { procMountInfoPath: options.procMountInfoPath }),
        });
  const effective = cgroup?.effectiveMemoryMax;
  return {
    hostAvailableBytes,
    cgroupMaxBytes: typeof effective === "number" ? effective : null,
    cgroupUsageBytes: cgroup?.usageBytes ?? null,
  };
};

/** Admit a launch only when the tightest (host, cgroup) availability fits. */
export const assessMemoryAdmission = (
  facts: HostMemoryAdmissionFacts,
  requiredBytes: number,
  options: { readonly minHeadroomBytes?: number } = {},
): MemoryAdmission => {
  const minHeadroom = options.minHeadroomBytes ?? 512 * 1024 * 1024;
  const cgroupRemaining =
    facts.cgroupMaxBytes === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, facts.cgroupMaxBytes - (facts.cgroupUsageBytes ?? 0));
  const available = Math.min(facts.hostAvailableBytes, cgroupRemaining);
  const needed = requiredBytes + minHeadroom;
  if (available < needed) {
    const cgroupText = Number.isFinite(cgroupRemaining)
      ? formatMib(cgroupRemaining)
      : "unlimited";
    return {
      admitted: false,
      reason: `Ghidra launch refused by memory guard: ${formatMib(available)} available (host ${formatMib(facts.hostAvailableBytes)}, cgroup remaining ${cgroupText}), ${formatMib(needed)} required`,
    };
  }
  return { admitted: true };
};
