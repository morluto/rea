import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { ProcessSample } from "../domain/processCapture.js";

const execFileAsync = promisify(execFile);
const PROC_READ_CONCURRENCY = 64;

interface ProcessRow {
  readonly pid: number;
  readonly parent_pid: number;
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
  readonly sampledPids: Set<number>;
  readonly identities: Map<number, string>;
  readonly signal: AbortSignal;
}

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
  const startTime = fields[19];
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(parentPid) ||
    parentPid < 0 ||
    startTime === undefined ||
    !/^\d+$/.test(startTime)
  )
    return undefined;
  return {
    pid,
    parent_pid: parentPid,
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

const readLinuxChildren = async (
  pid: number,
  signal: AbortSignal,
): Promise<readonly number[] | undefined> => {
  let text: string;
  try {
    text = await readFile(`/proc/${String(pid)}/task/${String(pid)}/children`, {
      encoding: "utf8",
      signal,
    });
  } catch (cause: unknown) {
    return handleProcReadFailure(cause);
  }
  return text
    .trim()
    .split(/\s+/)
    .filter((value) => /^\d+$/.test(value))
    .map(Number)
    .filter((child) => Number.isSafeInteger(child) && child > 0);
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
    startTime: before.startTime,
    command,
    children: children ?? [],
  };
};

const sampleLinux = async (
  context: SampleProcessContext,
): Promise<readonly ProcessRow[]> => {
  const { rootPid, limit, signal, sampledPids, identities } = context;
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

      if (!sampledPids.has(node.pid)) {
        if (rows.length >= limit) break;
        rows.push(node);
      }
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
    ["-axo", "pid=,ppid=,command="],
    { signal },
  );
  return stdout
    .split("\n")
    .map((line) => /\s*(\d+)\s+(\d+)\s+(.*)/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      parent_pid: Number(match[2]),
      command: match[3] ?? "",
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

const samplePs = async (
  context: SampleProcessContext,
): Promise<readonly ProcessRow[]> => {
  const { rootPid, limit, signal, sampledPids } = context;
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
    if (row !== undefined && !sampledPids.has(row.pid)) {
      result.push(row);
    }
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

  const { elapsedMs, sampledPids, identities } = context;
  const samples: ProcessSample[] = [];
  for (const row of rows) {
    if (sampledPids.has(row.pid)) continue;
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
    });
  }
  return samples;
};

/** Start bounded process-tree sampling and expose an awaited stop. */
export const startProcessSampler = (
  rootPid: number,
  started: number,
  limit: number,
  samples: ProcessSample[],
): (() => Promise<{ readonly partial: boolean }>) => {
  const identities = new Map<number, string>();
  const sampledPids = new Set<number>(samples.map(({ pid }) => pid));
  let pending: Promise<void> | undefined;
  let stopped = false;
  let abortCurrent: (() => void) | undefined;
  let partial = false;

  const sample = (): void => {
    if (stopped || pending !== undefined || sampledPids.size >= limit) return;

    const controller = new AbortController();
    abortCurrent = () => controller.abort();
    pending = sampleProcesses({
      rootPid,
      elapsedMs: Date.now() - started,
      limit: limit - sampledPids.size,
      sampledPids,
      identities,
      signal: controller.signal,
    })
      .then((values) => {
        for (const value of values) {
          if (sampledPids.size >= limit) break;
          if (sampledPids.has(value.pid)) continue;
          sampledPids.add(value.pid);
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
