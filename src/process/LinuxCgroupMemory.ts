import { open } from "node:fs/promises";
import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { posix } from "node:path";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  RegularFileCleanupFailure,
  withOwnedFileHandle,
} from "../filesystem/OwnedRegularFile.js";

/** Memory facts for the cgroup v2 group that holds this process. */
export interface LinuxCgroupMemoryState {
  /** Group path from `/proc/self/cgroup`, relative to the cgroup2 hierarchy root. */
  readonly path: string;
  /**
   * Hierarchical `oom_kill` count from `memory.events`. The kernel charges an
   * OOM kill to the victim's group and every ancestor, so a kill of any
   * process in this group or a child group raises it, whichever limit was
   * reached. Other processes can share this group.
   */
  readonly oomKills: number;
  /**
   * This group's `memory.max`: bytes, `max` when the group sets no limit, or
   * null when it could not be read. A limit on a parent group is not read.
   */
  readonly memoryMax: number | "max" | null;
}

/** One cgroup2 mount from `/proc/self/mountinfo`. */
interface LinuxCgroup2Mount {
  /** Hierarchy path that the mount exposes at its mount point. */
  readonly root: string;
  readonly mountPoint: string;
}

const KERNEL_FILE_BYTES = 16 * 1024;
/** Hosts with many container layers publish long mount tables. */
const MOUNT_INFO_BYTES = 4 * 1024 * 1024;

/** Decode only a selected path field, retaining literal U+FFFD as data. */
const decodeKernelPath = (raw: string): string | undefined => {
  try {
    return decodeStrictUtf8(Buffer.from(raw, "latin1"), "preserve");
  } catch {
    return undefined;
  }
};

/** Read the single cgroup v2 (`0::`) row of one `/proc/<pid>/cgroup` record. */
const parseLinuxCgroupV2Path = (value: Buffer): string | undefined => {
  let path: string | undefined;
  for (const line of value.toString("latin1").split("\n")) {
    if (!line.startsWith("0::")) continue;
    if (path !== undefined) return undefined;
    path = line.slice(3);
  }
  if (path === undefined || !path.startsWith("/")) return undefined;
  return path.split("/").includes("..") ? undefined : decodeKernelPath(path);
};

/** Read the single `oom_kill` counter of one cgroup v2 `memory.events` file. */
const parseLinuxCgroupOomKills = (value: string): number | undefined => {
  let count: number | undefined;
  for (const line of value.split("\n")) {
    const match = /^oom_kill ([0-9]+)$/u.exec(line);
    if (match === null) continue;
    if (count !== undefined) return undefined;
    count = Number(match[1]);
  }
  return count !== undefined && Number.isSafeInteger(count) ? count : undefined;
};

/** Read one cgroup v2 `memory.max` file; `max` means no limit. */
const parseLinuxCgroupMemoryMax = (
  value: string,
): number | "max" | undefined => {
  const token = value.trim();
  if (token === "max") return "max";
  if (!/^[0-9]+$/u.test(token)) return undefined;
  const bytes = Number(token);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
};

/** Decode the octal escapes the kernel writes for space, tab, newline and backslash. */
const mountInfoField = (value: string): string =>
  value.replace(/\\([0-7]{3})/gu, (_match, code: string) =>
    String.fromCharCode(Number.parseInt(code, 8)),
  );

/** List the cgroup2 mounts of one `/proc/<pid>/mountinfo` record. */
const parseLinuxCgroup2Mounts = (value: Buffer): readonly LinuxCgroup2Mount[] =>
  value
    .toString("latin1")
    .split("\n")
    .flatMap((line) => {
      const fields = line.split(" ");
      const separator = fields.indexOf("-");
      const root = fields[3];
      const mountPoint = fields[4];
      if (
        separator < 6 ||
        fields[separator + 1] !== "cgroup2" ||
        root === undefined ||
        mountPoint === undefined
      )
        return [];
      const decodedRoot = decodeKernelPath(root);
      const decodedMountPoint = decodeKernelPath(mountPoint);
      return decodedRoot === undefined || decodedMountPoint === undefined
        ? []
        : [
            {
              root: mountInfoField(decodedRoot),
              mountPoint: mountInfoField(decodedMountPoint),
            },
          ];
    });

interface LinuxCgroupLocation {
  readonly directory: string;
  readonly mountPoint: string;
}

/**
 * Locate a cgroup path below the mount whose root covers it most closely; a
 * mount that exposes only part of the hierarchy is joined from its own root.
 */
const linuxCgroupLocation = (
  mounts: readonly LinuxCgroup2Mount[],
  path: string,
): LinuxCgroupLocation | undefined => {
  let selected:
    | { readonly mount: LinuxCgroup2Mount; readonly rest: string }
    | undefined;
  for (const mount of mounts) {
    const rest =
      mount.root === "/"
        ? path
        : path === mount.root
          ? "/"
          : path.startsWith(`${mount.root}/`)
            ? path.slice(mount.root.length)
            : undefined;
    if (rest === undefined) continue;
    if (
      selected === undefined ||
      mount.root.length > selected.mount.root.length
    )
      selected = { mount, rest };
  }
  return selected === undefined
    ? undefined
    : {
        directory: posix.resolve(
          selected.mount.mountPoint,
          `.${selected.rest}`,
        ),
        mountPoint: selected.mount.mountPoint,
      };
};

/**
 * Observe this process's cgroup v2 memory group. Unavailable on other
 * platforms, under cgroup v1, or when the files are unreadable.
 */
export const readLinuxCgroupMemoryState = async (
  options: {
    readonly platform?: NodeJS.Platform;
    readonly procCgroupPath?: string;
    readonly procMountInfoPath?: string;
    readonly retainFailedClose?: (path: string, owner: OwnedFileHandle) => void;
  } = {},
): Promise<LinuxCgroupMemoryState | undefined> => {
  if ((options.platform ?? HOST_PLATFORM.platform) !== "linux")
    return undefined;
  const membership = await readKernelFile(
    options.procCgroupPath ?? "/proc/self/cgroup",
    undefined,
    options.retainFailedClose,
  );
  const path =
    membership === undefined ? undefined : parseLinuxCgroupV2Path(membership);
  if (path === undefined) return undefined;
  const mountInfo = await readKernelFile(
    options.procMountInfoPath ?? "/proc/self/mountinfo",
    MOUNT_INFO_BYTES,
    options.retainFailedClose,
  );
  const group =
    mountInfo === undefined
      ? undefined
      : linuxCgroupLocation(parseLinuxCgroup2Mounts(mountInfo), path);
  if (group === undefined) return undefined;
  const directory = group.directory;
  const events = await readKernelFile(
    posix.join(directory, "memory.events"),
    undefined,
    options.retainFailedClose,
  );
  const oomKills =
    events === undefined
      ? undefined
      : parseLinuxCgroupOomKills(events.toString("utf8"));
  if (oomKills === undefined) return undefined;
  const limit = await readKernelFile(
    posix.join(directory, "memory.max"),
    undefined,
    options.retainFailedClose,
  );
  return {
    path,
    oomKills,
    memoryMax:
      limit === undefined
        ? null
        : (parseLinuxCgroupMemoryMax(limit.toString("utf8")) ?? null),
  };
};

/** Reclaim-relevant memory facts used to decide whether a launch fits a cgroup. */
export interface LinuxCgroupAdmissionFacts {
  /**
   * Tightest finite `memory.max` on this process's cgroup or any visible
   * ancestor: bytes, `max` when no ancestor limits it, or null when unreadable.
   */
  readonly effectiveMemoryMax: number | "max" | null;
  /** This group's `memory.current` in bytes, or null when unreadable. */
  readonly usageBytes: number | null;
  /**
   * Smallest remaining bytes (`memory.max - memory.current`) across the group
   * and all visible ancestors with finite limits: bytes, or null when unlimited/unreadable.
   */
  readonly effectiveRemainingBytes: number | null;
}

/** Read one cgroup v2 `memory.current` byte count. */
const parseLinuxCgroupCurrent = (value: string): number | null => {
  const token = value.trim();
  if (!/^[0-9]+$/u.test(token)) return null;
  const bytes = Number(token);
  return Number.isSafeInteger(bytes) ? bytes : null;
};

/**
 * Find candidate ancestor cgroup directories across all covering mounts for each ancestor path,
 * preserving all covering mounts so unreadable outer mounts do not mask readable delegated mounts.
 */
const resolveAncestorCgroupDirectories = (
  mounts: readonly LinuxCgroup2Mount[],
  leafPath: string,
): readonly (readonly string[])[] => {
  const leafCovered = mounts.some(
    (mount) =>
      mount.root === "/" ||
      leafPath === mount.root ||
      leafPath.startsWith(`${mount.root}/`),
  );
  if (!leafCovered) return [];

  const cgroupPaths: string[] = [];
  let current = leafPath;
  for (;;) {
    cgroupPaths.push(current);
    if (current === "/") break;
    const parent = posix.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const ancestorDirectories: (readonly string[])[] = [];

  for (const cgroupPath of cgroupPaths) {
    const candidateMounts = mounts.filter(
      (mount) =>
        mount.root === "/" ||
        cgroupPath === mount.root ||
        cgroupPath.startsWith(`${mount.root}/`),
    );
    const sorted = [...candidateMounts].sort(
      (a, b) => b.root.length - a.root.length,
    );
    const directories: string[] = [];
    const visited = new Set<string>();

    for (const mount of sorted) {
      const rest =
        mount.root === "/"
          ? cgroupPath
          : cgroupPath === mount.root
            ? "/"
            : cgroupPath.slice(mount.root.length);
      const directory = posix.resolve(mount.mountPoint, `.${rest}`);
      if (!visited.has(directory)) {
        visited.add(directory);
        directories.push(directory);
      }
    }

    if (directories.length > 0) {
      ancestorDirectories.push(directories);
    }
  }

  return ancestorDirectories;
};

interface DirectoryMemoryMetrics {
  readonly max: number | "max" | undefined;
  readonly current: number | null;
}

const readDirectoryMemoryMetrics = async (
  directory: string,
  retainFailedClose?: (path: string, owner: OwnedFileHandle) => void,
): Promise<DirectoryMemoryMetrics> => {
  const rawMax = await readKernelFile(
    posix.join(directory, "memory.max"),
    undefined,
    retainFailedClose,
  );
  const max =
    rawMax === undefined
      ? undefined
      : parseLinuxCgroupMemoryMax(rawMax.toString("utf8"));

  const rawCurrent = await readKernelFile(
    posix.join(directory, "memory.current"),
    undefined,
    retainFailedClose,
  );
  const current =
    rawCurrent === undefined
      ? null
      : parseLinuxCgroupCurrent(rawCurrent.toString("utf8"));

  return { max, current };
};

const readAncestorMemoryMetrics = async (
  candidateDirectories: readonly string[],
  retainFailedClose?: (path: string, owner: OwnedFileHandle) => void,
): Promise<DirectoryMemoryMetrics> => {
  let max: number | "max" | undefined = undefined;
  let current: number | null = null;

  for (const directory of candidateDirectories) {
    const metrics = await readDirectoryMemoryMetrics(
      directory,
      retainFailedClose,
    );
    if (max === undefined && metrics.max !== undefined) {
      max = metrics.max;
    }
    if (current === null && metrics.current !== null) {
      current = metrics.current;
    }
    if (max !== undefined && current !== null) {
      break;
    }
  }

  return { max, current };
};

interface AncestorAccumulator {
  tightestMax: number | "max" | null;
  tightestRemaining: number | null;
  leafUsageBytes: number | null;
  knownDescendantUsage: number | null;
}

const updateAncestorMetrics = (
  acc: AncestorAccumulator,
  metrics: DirectoryMemoryMetrics,
  isLeaf: boolean,
): void => {
  if (isLeaf) {
    acc.leafUsageBytes = metrics.current;
  }
  if (metrics.current !== null) {
    acc.knownDescendantUsage =
      acc.knownDescendantUsage === null
        ? metrics.current
        : Math.max(acc.knownDescendantUsage, metrics.current);
  }
  if (metrics.max === "max") {
    if (acc.tightestMax === null) acc.tightestMax = "max";
  } else if (metrics.max !== undefined) {
    acc.tightestMax =
      acc.tightestMax === null || acc.tightestMax === "max"
        ? metrics.max
        : Math.min(acc.tightestMax, metrics.max);

    const effectiveCharge = metrics.current ?? acc.knownDescendantUsage;
    if (effectiveCharge !== null) {
      const remaining = Math.max(0, metrics.max - effectiveCharge);
      acc.tightestRemaining =
        acc.tightestRemaining === null
          ? remaining
          : Math.min(acc.tightestRemaining, remaining);
    }
  }
};

/**
 * Read the effective cgroup memory ceiling for this process: the tightest
 * finite `memory.max` across the group and its visible ancestors, together
 * with the smallest remaining allowance (`memory.max - memory.current`)
 * across all levels to account for sibling memory use in parent groups.
 */
export const readLinuxCgroupAdmissionFacts = async (
  options: {
    readonly platform?: NodeJS.Platform;
    readonly procCgroupPath?: string;
    readonly procMountInfoPath?: string;
    readonly retainFailedClose?: (path: string, owner: OwnedFileHandle) => void;
  } = {},
): Promise<LinuxCgroupAdmissionFacts | undefined> => {
  if ((options.platform ?? HOST_PLATFORM.platform) !== "linux")
    return undefined;
  const membership = await readKernelFile(
    options.procCgroupPath ?? "/proc/self/cgroup",
    undefined,
    options.retainFailedClose,
  );
  const path =
    membership === undefined ? undefined : parseLinuxCgroupV2Path(membership);
  if (path === undefined) return undefined;
  const mountInfo = await readKernelFile(
    options.procMountInfoPath ?? "/proc/self/mountinfo",
    MOUNT_INFO_BYTES,
    options.retainFailedClose,
  );
  if (mountInfo === undefined) return undefined;
  const mounts = parseLinuxCgroup2Mounts(mountInfo);
  const ancestorDirectories = resolveAncestorCgroupDirectories(mounts, path);
  if (ancestorDirectories.length === 0) return undefined;

  const acc: AncestorAccumulator = {
    tightestMax: null,
    tightestRemaining: null,
    leafUsageBytes: null,
    knownDescendantUsage: null,
  };

  for (let index = 0; index < ancestorDirectories.length; index += 1) {
    const candidates = ancestorDirectories[index];
    if (candidates === undefined || candidates.length === 0) continue;

    const metrics = await readAncestorMemoryMetrics(
      candidates,
      options.retainFailedClose,
    );
    updateAncestorMetrics(acc, metrics, index === 0);
  }

  const effectiveRemaining =
    acc.tightestRemaining === null || typeof acc.tightestMax !== "number"
      ? acc.tightestRemaining
      : Math.min(acc.tightestRemaining, acc.tightestMax);

  return {
    effectiveMemoryMax: acc.tightestMax,
    usageBytes: acc.leafUsageBytes,
    effectiveRemainingBytes: effectiveRemaining,
  };
};

/**
 * Read a kernel report to EOF within a fixed budget; procfs may return it in
 * several short reads. Absent on any failure or when the budget is exceeded.
 */
const readKernelFile = async (
  path: string,
  maxBytes = KERNEL_FILE_BYTES,
  retainFailedClose?: (path: string, owner: OwnedFileHandle) => void,
): Promise<Buffer | undefined> => {
  try {
    return await withOwnedFileHandle(
      path,
      new OwnedFileHandle(await open(path, "r")),
      retainFailedClose === undefined
        ? {}
        : { retainFailedClose: (owner) => retainFailedClose(path, owner) },
      async (handle) => {
        const buffer = Buffer.alloc(maxBytes + 1);
        let length = 0;
        for (;;) {
          const { bytesRead } = await handle.read(
            buffer,
            length,
            buffer.length - length,
            null,
          );
          if (bytesRead === 0) break;
          length += bytesRead;
          if (length > maxBytes) return undefined;
        }
        return buffer.subarray(0, length);
      },
    );
  } catch (cause: unknown) {
    if (
      cause instanceof RegularFileCleanupFailure &&
      cause.retention.kind !== "callback_returned"
    )
      throw cause;
    return undefined;
  }
};
