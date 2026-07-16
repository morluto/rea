import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import type { ProcessSample } from "../domain/processCapture.js";
import { readProcessRunId } from "../process/ProcessOwnership.js";

const execFileAsync = promisify(execFile);
const PROC_READ_CONCURRENCY = 64;

interface ProcessRow {
  readonly pid: number;
  readonly parent_pid: number;
  readonly process_group_id: number | null;
  readonly session_id: number | null;
  readonly command: string;
  readonly startTime: string | undefined;
}

interface ProcessNode extends ProcessRow {
  readonly children: readonly number[];
}

interface SampleProcessContext {
  readonly rootPid: number;
  readonly elapsedMs: number;
  readonly limit: number;
  readonly identities: Map<number, string>;
  readonly signal: AbortSignal;
}

type ProcessIdentitySnapshot = Pick<
  ProcessRow,
  "pid" | "parent_pid" | "process_group_id" | "session_id" | "startTime"
>;

/** Prove that forkpty completed session setup and installed the run token. */
export const isInitializedPtyRoot = (options: {
  readonly rootPid: number;
  readonly expectedRunId: string;
  readonly before: ProcessIdentitySnapshot;
  readonly observedRunId: string | undefined;
  readonly after: ProcessIdentitySnapshot;
}): boolean => {
  const sessionIdentityMatches =
    (options.before.session_id === options.rootPid &&
      options.after.session_id === options.rootPid) ||
    (options.before.session_id === null && options.after.session_id === null);
  return (
    options.before.pid === options.rootPid &&
    options.before.process_group_id === options.rootPid &&
    sessionIdentityMatches &&
    options.after.pid === options.rootPid &&
    options.after.parent_pid === options.before.parent_pid &&
    options.after.process_group_id === options.rootPid &&
    options.after.startTime === options.before.startTime &&
    options.observedRunId === options.expectedRunId
  );
};

const isExpectedProcReadFailure = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "ENOENT" ||
    cause.code === "ESRCH" ||
    cause.code === "EACCES" ||
    cause.code === "EPERM");

const handleProcReadFailure = (cause: unknown): undefined => {
  if (isExpectedProcReadFailure(cause)) return undefined;
  throw cause;
};

const parseProcStat = (
  identifier: string,
  stat: string,
): ProcessRow | undefined => {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return undefined;
  const fields = stat
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);
  const pid = Number(identifier);
  const parentPid = Number(fields[1]);
  const processGroupId = Number(fields[2]);
  const sessionId = Number(fields[3]);
  const startTime = fields[19];
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(parentPid) ||
    parentPid < 0 ||
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 0 ||
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 0 ||
    startTime === undefined ||
    !/^\d+$/.test(startTime)
  )
    return undefined;
  return {
    pid,
    parent_pid: parentPid,
    process_group_id: processGroupId,
    session_id: sessionId,
    command: "",
    startTime,
  };
};

const readProcessStat = async (
  pid: number,
  signal: AbortSignal,
): Promise<ProcessRow | undefined> => {
  try {
    const stat = await readFile(`/proc/${String(pid)}/stat`, {
      encoding: "utf8",
      signal,
    });
    return parseProcStat(String(pid), stat);
  } catch (cause: unknown) {
    return handleProcReadFailure(cause);
  }
};

const readProcessCommand = async (
  pid: number,
  signal: AbortSignal,
): Promise<Buffer | undefined> => {
  try {
    return await readFile(`/proc/${String(pid)}/cmdline`, { signal });
  } catch (cause: unknown) {
    return handleProcReadFailure(cause);
  }
};

/** Procfs reads used to enumerate children created by every process thread. */
export interface LinuxChildrenHost {
  taskIds(
    pid: number,
    signal: AbortSignal,
  ): Promise<readonly number[] | undefined>;
  children(
    pid: number,
    taskId: number,
    signal: AbortSignal,
  ): Promise<string | undefined>;
}

const systemLinuxChildrenHost: LinuxChildrenHost = {
  async taskIds(pid, signal) {
    try {
      signal.throwIfAborted();
      const entries = await readdir(`/proc/${String(pid)}/task`);
      signal.throwIfAborted();
      return entries
        .filter((entry) => /^\d+$/.test(entry))
        .map(Number)
        .filter((taskId) => Number.isSafeInteger(taskId) && taskId > 0)
        .sort((left, right) => left - right);
    } catch (cause: unknown) {
      return handleProcReadFailure(cause);
    }
  },
  async children(pid, taskId, signal) {
    try {
      return await readFile(
        `/proc/${String(pid)}/task/${String(taskId)}/children`,
        { encoding: "utf8", signal },
      );
    } catch (cause: unknown) {
      return handleProcReadFailure(cause);
    }
  },
};

/** Read the deduplicated children created by every thread in a Linux process. */
export const readLinuxChildren = async (
  pid: number,
  signal: AbortSignal,
  host: LinuxChildrenHost = systemLinuxChildrenHost,
): Promise<readonly number[] | undefined> => {
  const taskIds = await host.taskIds(pid, signal);
  if (taskIds === undefined) return undefined;
  const children = new Set<number>();
  let successfulReads = 0;
  for (
    let offset = 0;
    offset < taskIds.length;
    offset += PROC_READ_CONCURRENCY
  ) {
    const texts = await Promise.all(
      taskIds
        .slice(offset, offset + PROC_READ_CONCURRENCY)
        .map((taskId) => host.children(pid, taskId, signal)),
    );
    for (const text of texts) {
      if (text === undefined) continue;
      successfulReads += 1;
      for (const value of text.trim().split(/\s+/)) {
        if (!/^\d+$/.test(value)) continue;
        const child = Number(value);
        if (Number.isSafeInteger(child) && child > 0) children.add(child);
      }
    }
  }
  return successfulReads === 0
    ? undefined
    : [...children].sort((left, right) => left - right);
};

const inspectProcess = async (
  pid: number,
  expectedParent: number | undefined,
  signal: AbortSignal,
  identities: Map<number, string>,
): Promise<ProcessNode | undefined> => {
  const before = await readProcessStat(pid, signal);
  if (before === undefined || before.startTime === undefined) return undefined;

  const existing = identities.get(pid);
  if (existing !== undefined && existing !== before.startTime) return undefined;
  if (expectedParent !== undefined && before.parent_pid !== expectedParent)
    return undefined;

  const [commandBuffer, children] = await Promise.all([
    readProcessCommand(pid, signal),
    readLinuxChildren(pid, signal),
  ]);

  const after = await readProcessStat(pid, signal);
  if (after === undefined || after.startTime === undefined) return undefined;
  if (
    before.startTime !== after.startTime ||
    before.parent_pid !== after.parent_pid
  )
    return undefined;
  if (expectedParent !== undefined && after.parent_pid !== expectedParent)
    return undefined;

  const command =
    commandBuffer === undefined
      ? ""
      : commandBuffer.toString().replaceAll("\0", " ").trim();

  return {
    pid: before.pid,
    parent_pid: before.parent_pid,
    process_group_id: before.process_group_id,
    session_id: before.session_id,
    startTime: before.startTime,
    command,
    children: children ?? [],
  };
};

const sampleLinux = async (
  context: SampleProcessContext,
): Promise<readonly ProcessRow[]> => {
  const { rootPid, limit, signal, identities } = context;
  if (limit <= 0) return [];

  const rootStat = await readProcessStat(rootPid, signal);
  if (rootStat === undefined) return [];
  const rootChildren = await readLinuxChildren(rootPid, signal);
  if (rootChildren === undefined) return samplePs(context);

  const rows: ProcessRow[] = [];
  const visited = new Set<number>([rootPid]);
  let level: Array<{
    readonly pid: number;
    readonly expectedParent: number | undefined;
  }> = [{ pid: rootPid, expectedParent: undefined }];

  while (level.length > 0 && rows.length < limit) {
    const batchSize = Math.min(level.length, PROC_READ_CONCURRENCY);
    const batch = level.slice(0, batchSize);
    level = level.slice(batchSize);

    const batchResults = await Promise.all(
      batch.map((item) =>
        inspectProcess(item.pid, item.expectedParent, signal, identities),
      ),
    );

    const nextLevel: typeof batch = [];
    for (const node of batchResults) {
      if (node === undefined) continue;

      if (rows.length >= limit) break;
      rows.push(node);
      if (rows.length >= limit) break;

      for (const child of node.children) {
        if (visited.has(child)) continue;
        visited.add(child);
        nextLevel.push({ pid: child, expectedParent: node.pid });
      }
      if (rows.length >= limit) break;
    }

    level.push(...nextLevel);
  }

  return rows;
};

const readPsRows = async (
  signal: AbortSignal,
): Promise<readonly ProcessRow[]> => {
  const { stdout } = await execFileAsync(
    "ps",
    ["-axo", "pid=,ppid=,pgid=,sess=,command="],
    { signal },
  );
  return stdout
    .split("\n")
    .map((line) => /\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      parent_pid: Number(match[2]),
      process_group_id: Number(match[3]),
      session_id: Number(match[4]) || null,
      command: match[5] ?? "",
      startTime: undefined,
    }))
    .filter(
      (row) =>
        Number.isSafeInteger(row.pid) &&
        row.pid > 0 &&
        Number.isSafeInteger(row.parent_pid) &&
        row.parent_pid >= 0,
    )
    .sort((left, right) => left.pid - right.pid);
};

const readRootIdentity = async (
  rootPid: number,
  signal: AbortSignal,
): Promise<ProcessRow | undefined> =>
  process.platform === "linux"
    ? readProcessStat(rootPid, signal)
    : (await readPsRows(signal)).find(({ pid }) => pid === rootPid);

const inspectInitializedPtyRoot = async (
  rootPid: number,
  runId: string,
  signal: AbortSignal,
): Promise<{ readonly startTime: string | undefined } | undefined> => {
  const before = await readRootIdentity(rootPid, signal);
  if (
    before === undefined ||
    before.process_group_id !== rootPid ||
    (before.session_id !== rootPid && before.session_id !== null)
  )
    return undefined;
  let observedRunId: string | undefined;
  try {
    observedRunId = await readProcessRunId(rootPid);
  } catch {
    return undefined;
  }
  const after = await readRootIdentity(rootPid, signal);
  if (
    after === undefined ||
    !isInitializedPtyRoot({
      rootPid,
      expectedRunId: runId,
      before,
      observedRunId,
      after,
    })
  )
    return undefined;
  return { startTime: after.startTime };
};

const samplePs = async (
  context: SampleProcessContext,
): Promise<readonly ProcessRow[]> => {
  const { rootPid, limit, signal } = context;
  if (limit <= 0) return [];

  const rows = await readPsRows(signal);
  const rowByPid = new Map(rows.map((row) => [row.pid, row]));
  const childrenByParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const siblings = childrenByParent.get(row.parent_pid) ?? [];
    siblings.push(row);
    childrenByParent.set(row.parent_pid, siblings);
  }

  const result: ProcessRow[] = [];
  const visited = new Set<number>();
  const queue: number[] = [rootPid];
  let index = 0;

  while (index < queue.length && result.length < limit) {
    const pid = queue[index];
    if (pid === undefined) break;
    index += 1;
    if (visited.has(pid)) continue;
    visited.add(pid);

    const row = rowByPid.get(pid);
    if (row !== undefined) result.push(row);
    if (result.length >= limit) break;

    for (const child of childrenByParent.get(pid) ?? []) {
      if (!visited.has(child.pid)) queue.push(child.pid);
    }
  }

  return result;
};

const sampleProcesses = async (
  context: SampleProcessContext,
): Promise<readonly ProcessSample[]> => {
  if (process.platform === "win32" || context.limit <= 0) return [];

  const rows =
    process.platform === "linux"
      ? await sampleLinux(context)
      : await samplePs(context);

  const { elapsedMs, identities } = context;
  const samples: ProcessSample[] = [];
  for (const row of rows) {
    if (row.startTime !== undefined) {
      const existing = identities.get(row.pid);
      if (existing !== undefined && existing !== row.startTime) continue;
      identities.set(row.pid, row.startTime);
    }
    samples.push({
      at_ms: elapsedMs,
      pid: row.pid,
      parent_pid: row.parent_pid,
      command: row.command,
      process_group_id: row.process_group_id,
      session_id: row.session_id,
    });
  }
  return samples;
};

/** Start bounded process-tree sampling and expose an awaited stop. */
export const startProcessSampler = (options: {
  readonly rootPid: number;
  readonly runId: string;
  readonly started: number;
  readonly limit: number;
  readonly samples: ProcessSample[];
}): (() => Promise<{ readonly partial: boolean }>) => {
  const { rootPid, runId, started, limit, samples } = options;
  const identities = new Map<number, string>();
  const lastObservations = new Map<number, string>();
  let pending: Promise<void> | undefined;
  let stopped = false;
  let abortCurrent: (() => void) | undefined;
  let partial = false;
  let rootInitialized = false;

  const sample = (): void => {
    if (stopped || pending !== undefined) return;

    const controller = new AbortController();
    abortCurrent = () => controller.abort();
    pending = (async () => {
      if (!rootInitialized) {
        const identity = await inspectInitializedPtyRoot(
          rootPid,
          runId,
          controller.signal,
        );
        if (identity === undefined) return [];
        if (identity.startTime !== undefined)
          identities.set(rootPid, identity.startTime);
        rootInitialized = true;
      }
      return sampleProcesses({
        rootPid,
        elapsedMs: Date.now() - started,
        limit: limit + 1,
        identities,
        signal: controller.signal,
      });
    })()
      .then((values) => {
        for (const value of values) {
          const observation = JSON.stringify({
            parent_pid: value.parent_pid,
            command: value.command,
            process_group_id: value.process_group_id,
            session_id: value.session_id,
          });
          if (lastObservations.get(value.pid) === observation) continue;
          if (samples.length >= limit) {
            partial = true;
            continue;
          }
          lastObservations.set(value.pid, observation);
          samples.push(value);
        }
      })
      .catch((cause: unknown) => {
        if (!(cause instanceof Error && cause.name === "AbortError"))
          partial = true;
      })
      .then(() => {
        abortCurrent = undefined;
        pending = undefined;
      });
  };

  const timer = setInterval(sample, 50);
  sample();

  return async () => {
    stopped = true;
    clearInterval(timer);
    abortCurrent?.();
    await pending;
    return { partial };
  };
};
