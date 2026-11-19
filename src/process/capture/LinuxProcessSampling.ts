import { readProcessInspectionFile } from "../ProcessInspectionFile.js";
import { readdir, readlink } from "node:fs/promises";
import { parseLinuxProcessStat } from "../LinuxProcessStat.js";
import type { ProcessLifecycle } from "../ProcessLifecycle.js";
import {
  settleSamplingReads,
  mergeSamplingDiagnostics,
  readProcSamplingSource,
  samplingFailure,
  samplingObservation,
  samplingInterrupted,
  type SamplingObservation,
} from "./ProcessSamplingObservation.js";

export const PROC_READ_CONCURRENCY = 64;

export interface SampledProcessRow {
  readonly pid: number;
  readonly parent_pid: number;
  readonly process_group_id: number | null;
  readonly session_id: number | null;
  readonly command: string;
  readonly startTime: string | undefined;
  /** Native lifecycle from the stat record; undefined when ps supplied the row. */
  readonly lifecycle: ProcessLifecycle | undefined;
}

export interface SampledProcessNode extends SampledProcessRow {
  readonly children: readonly number[] | undefined;
}

export type LinuxProcessStatRow = SampledProcessRow & {
  readonly startTime: string;
};

export const readLinuxProcessStat = async (
  pid: number,
  signal: AbortSignal,
): Promise<SamplingObservation<LinuxProcessStatRow | undefined>> => {
  const path = `/proc/${String(pid)}/stat`;
  const read = await readProcSamplingSource(path, signal, () =>
    readProcessInspectionFile(path, signal),
  );
  if (read.value === undefined)
    return samplingObservation(undefined, read.diagnostics);
  const parsed = parseLinuxProcessStat(read.value);
  if (parsed === undefined || parsed.pid !== pid)
    return samplingObservation(
      undefined,
      read.diagnostics,
      samplingFailure(`${path}: malformed process identity`),
    );
  // A valid stat record can outlive its group/session relation during teardown.
  // It cannot supply an attributable sample, but is not a parser failure.
  if (parsed.processGroupId <= 0 || parsed.sessionId <= 0)
    return samplingObservation(undefined, read.diagnostics);
  return samplingObservation(
    {
      pid: parsed.pid,
      parent_pid: parsed.parentPid,
      process_group_id: parsed.processGroupId,
      session_id: parsed.sessionId,
      command: "",
      startTime: parsed.startTime,
      lifecycle: parsed.lifecycle,
    },
    read.diagnostics,
  );
};

/** Procfs operations remain injectable below error classification and composition. */
export interface LinuxChildrenHost {
  taskIds(pid: number, signal: AbortSignal): Promise<readonly number[]>;
  children(pid: number, taskId: number, signal: AbortSignal): Promise<string>;
}

const systemLinuxChildrenHost: LinuxChildrenHost = {
  async taskIds(pid) {
    const entries = await readdir(`/proc/${String(pid)}/task`);
    return entries
      .filter((entry) => /^\d+$/u.test(entry))
      .map(Number)
      .filter((taskId) => Number.isSafeInteger(taskId) && taskId > 0)
      .sort((left, right) => left - right);
  },
  children(pid, taskId, signal) {
    return readProcessInspectionFile(
      `/proc/${String(pid)}/task/${String(taskId)}/children`,
      signal,
    );
  },
};

/** Keep the child union and diagnostics from independently readable process threads. */
export const readLinuxChildren = async (
  pid: number,
  signal: AbortSignal,
  host: LinuxChildrenHost = systemLinuxChildrenHost,
): Promise<SamplingObservation<readonly number[] | undefined>> => {
  const tasks = await readProcSamplingSource(
    `/proc/${String(pid)}/task`,
    signal,
    () => host.taskIds(pid, signal),
  );
  if (tasks.value === undefined)
    return samplingObservation(undefined, tasks.diagnostics);
  if (tasks.value.length === 0)
    return samplingObservation([], tasks.diagnostics);
  const children = new Set<number>();
  let diagnostics = tasks.diagnostics;
  let successfulReads = 0;
  let offset = 0;
  for (
    ;
    offset < tasks.value.length && !signal.aborted;
    offset += PROC_READ_CONCURRENCY
  ) {
    const texts = await settleSamplingReads(
      tasks.value
        .slice(offset, offset + PROC_READ_CONCURRENCY)
        .map((taskId) =>
          readProcSamplingSource(
            `/proc/${String(pid)}/task/${String(taskId)}/children`,
            signal,
            () => host.children(pid, taskId, signal),
          ),
        ),
    );
    for (const text of texts) {
      diagnostics = mergeSamplingDiagnostics(diagnostics, text.diagnostics);
      if (text.value === undefined) continue;
      successfulReads += 1;
      for (const value of text.value.trim().split(/\s+/u)) {
        if (!/^\d+$/u.test(value)) continue;
        const child = Number(value);
        if (Number.isSafeInteger(child) && child > 0) children.add(child);
      }
    }
  }
  if (offset < tasks.value.length && signal.aborted)
    diagnostics = mergeSamplingDiagnostics(diagnostics, samplingInterrupted());
  return samplingObservation(
    successfulReads === 0 ? undefined : [...children].sort((a, b) => a - b),
    diagnostics,
  );
};

/** Attribute details to an initial Linux process observation only while its identity and parent agree. */
export const readStableLinuxProcessDetails = async <T>(
  before: SamplingObservation<LinuxProcessStatRow | undefined>,
  readStat: () => Promise<SamplingObservation<LinuxProcessStatRow | undefined>>,
  readDetails: (row: LinuxProcessStatRow) => Promise<SamplingObservation<T>>,
): Promise<
  SamplingObservation<
    { readonly row: LinuxProcessStatRow; readonly details: T } | undefined
  >
> => {
  if (before.value === undefined)
    return samplingObservation(undefined, before.diagnostics);
  const details = await readDetails(before.value);
  const after = await readStat();
  const diagnostics = mergeSamplingDiagnostics(
    before.diagnostics,
    details.diagnostics,
    after.diagnostics,
  );
  if (
    after.value === undefined ||
    before.value.pid !== after.value.pid ||
    before.value.startTime !== after.value.startTime ||
    before.value.parent_pid !== after.value.parent_pid
  )
    return samplingObservation(undefined, diagnostics);
  return samplingObservation(
    { row: before.value, details: details.value },
    diagnostics,
  );
};

/** Admit the first stat row against the capture's already-established lineage. */
const inspectStableLinuxProcess = async <T>(
  pid: number,
  signal: AbortSignal,
  lineage: {
    readonly expectedParent: number | undefined;
    readonly identities: ReadonlyMap<number, string>;
  },
  readDetails: () => Promise<SamplingObservation<T>>,
) => {
  const readStat = () => readLinuxProcessStat(pid, signal);
  const before = await readStat();
  const { expectedParent, identities } = lineage;
  const existing = identities.get(pid);
  if (
    (existing !== undefined && existing !== before.value?.startTime) ||
    (expectedParent !== undefined &&
      before.value?.parent_pid !== expectedParent)
  )
    return samplingObservation(undefined, before.diagnostics);
  return readStableLinuxProcessDetails(before, readStat, readDetails);
};

export const readLinuxCommand = async (
  pid: number,
  signal: AbortSignal,
): Promise<SamplingObservation<string>> => {
  const path = `/proc/${String(pid)}/cmdline`;
  const command = await readProcSamplingSource(path, signal, () =>
    readProcessInspectionFile(path, signal),
  );
  return samplingObservation(
    command.value?.toString().replaceAll("\0", " ").trim() ?? "",
    command.diagnostics,
  );
};

/** Read named file targets from procfs. Callers attribute them through the process identity bracket. */
export const readLinuxOpenFiles = async (
  pid: number,
  signal: AbortSignal,
): Promise<SamplingObservation<readonly string[]>> => {
  const directory = `/proc/${String(pid)}/fd`;
  const listing = await readProcSamplingSource(directory, signal, () =>
    readdir(directory),
  );
  const paths: string[] = [];
  let diagnostics = listing.diagnostics;
  for (const descriptor of listing.value ?? []) {
    if (signal.aborted) {
      diagnostics = mergeSamplingDiagnostics(
        diagnostics,
        samplingInterrupted(),
      );
      break;
    }
    const path = `${directory}/${descriptor}`;
    const target = await readProcSamplingSource(path, signal, () =>
      readlink(path),
    );
    diagnostics = mergeSamplingDiagnostics(diagnostics, target.diagnostics);
    if (target.value?.startsWith("/"))
      paths.push(target.value.replace(/ \(deleted\)$/u, ""));
  }
  return samplingObservation(paths, diagnostics);
};

/** Inspect a ps-discovered PID without trusting ps for Linux identity or command. */
export const inspectLinuxProcessMetadata = async (
  pid: number,
  expectedParent: number,
  signal: AbortSignal,
  identities: ReadonlyMap<number, string>,
): Promise<SamplingObservation<SampledProcessRow | undefined>> => {
  const observed = await inspectStableLinuxProcess(
    pid,
    signal,
    { expectedParent, identities },
    () => readLinuxCommand(pid, signal),
  );
  return samplingObservation(
    observed.value === undefined
      ? undefined
      : {
          ...observed.value.row,
          command: observed.value.details,
        },
    observed.diagnostics,
  );
};

/** Failed optional reads qualify a stable row instead of erasing it or its peers. */
export const inspectLinuxProcess = async (
  pid: number,
  expectedParent: number | undefined,
  signal: AbortSignal,
  identities: ReadonlyMap<number, string>,
): Promise<SamplingObservation<SampledProcessNode | undefined>> => {
  const observed = await inspectStableLinuxProcess(
    pid,
    signal,
    { expectedParent, identities },
    async () => {
      const [command, children] = await settleSamplingReads([
        readLinuxCommand(pid, signal),
        readLinuxChildren(pid, signal),
      ]);
      return samplingObservation(
        { command: command.value, children: children.value },
        command.diagnostics,
        children.diagnostics,
      );
    },
  );
  return samplingObservation(
    observed.value === undefined
      ? undefined
      : {
          ...observed.value.row,
          ...observed.value.details,
        },
    observed.diagnostics,
  );
};
