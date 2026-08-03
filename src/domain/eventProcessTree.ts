import { z } from "zod";

/** Event types for event-backed process-tree capture. */
export const processEventTypeSchema = z.enum([
  "spawn",
  "exit",
  "re_exec",
  "reparent",
  "signal",
  "name_change",
  "thread_create",
  "thread_exit",
]);
export type ProcessEventType = z.infer<typeof processEventTypeSchema>;

/** A single event-backed process-tree event. */
export const processTreeEventSchema = z.strictObject({
  /** Monotonic event sequence number. */
  sequence: z.number().int().nonnegative(),
  /** Event timestamp in milliseconds. */
  at_ms: z.number().int().nonnegative(),
  /** Event type. */
  type: processEventTypeSchema,
  /** Process ID. */
  pid: z.number().int().positive(),
  /** Parent process ID. */
  ppid: z.number().int().nullable(),
  /** Process name if known. */
  process_name: z.string().nullable(),
  /** Executable path if known. */
  executable: z.string().nullable(),
  /** Command line arguments. */
  arguments: z.array(z.string()).default([]),
  /** Previous PID (for reparent events). */
  previous_pid: z.number().int().nullable(),
  /** Previous PPID (for reparent events). */
  previous_ppid: z.number().int().nullable(),
  /** Exit code (for exit events). */
  exit_code: z.number().int().nullable(),
  /** Signal number (for signal events). */
  signal: z.number().int().nullable(),
  /** Thread ID (for thread events). */
  tid: z.number().int().nullable(),
});
export type ProcessTreeEvent = z.infer<typeof processTreeEventSchema>;

/** Process node in a reconstructed tree. */
export const processNodeSchema = z.strictObject({
  pid: z.number().int().positive(),
  ppid: z.number().int().nullable(),
  process_name: z.string().nullable(),
  executable: z.string().nullable(),
  arguments: z.array(z.string()).default([]),
  children: z.array(z.number().int()).default([]),
  spawn_time_ms: z.number().int().nullable(),
  exit_time_ms: z.number().int().nullable(),
  exit_code: z.number().int().nullable(),
  is_re_exec: z.boolean().default(false),
  is_reparented: z.boolean().default(false),
  previous_ppid: z.number().int().nullable(),
});
export type ProcessNode = z.infer<typeof processNodeSchema>;

/** Result of event-backed process-tree reconstruction. */
export const processTreeReconstructionSchema = z.strictObject({
  /** Root PID of the process tree. */
  root_pid: z.number().int().positive(),
  /** All reconstructed process nodes. */
  processes: z.array(processNodeSchema).min(0).max(10_000),
  /** Events that were consumed. */
  events_consumed: z.number().int().nonnegative(),
  /** Events that could not be matched. */
  events_unmatched: z.number().int().nonnegative(),
  /** Short-lived descendants that were missed by sampling. */
  short_lived_descendants: z.number().int().nonnegative(),
  /** Whether any re-exec was detected. */
  has_re_exec: z.boolean().default(false),
  /** Whether any reparenting was detected. */
  has_reparenting: z.boolean().default(false),
});
export type ProcessTreeReconstruction = z.infer<
  typeof processTreeReconstructionSchema
>;

type ProcessTreeAccumulator = {
  readonly nodes: Map<number, ProcessNode>;
  readonly children: Map<number, number[]>;
  eventsUnmatched: number;
  hasReExec: boolean;
  hasReparenting: boolean;
  shortLivedDescendants: number;
};

const applyProcessTreeEvent = (
  event: ProcessTreeEvent,
  state: ProcessTreeAccumulator,
): void => {
  let node = state.nodes.get(event.pid);
  switch (event.type) {
    case "spawn": {
      if (!node) {
        node = {
          pid: event.pid,
          ppid: event.ppid,
          process_name: event.process_name,
          executable: event.executable,
          arguments: event.arguments,
          children: [],
          spawn_time_ms: event.at_ms,
          exit_time_ms: null,
          exit_code: null,
          is_re_exec: false,
          is_reparented: false,
          previous_ppid: null,
        };
        state.nodes.set(event.pid, node);
      }
      if (event.ppid !== null) {
        const parentChildren = state.children.get(event.ppid) ?? [];
        parentChildren.push(event.pid);
        state.children.set(event.ppid, parentChildren);
      }
      break;
    }
    case "exit":
      if (node) {
        node.exit_time_ms = event.at_ms;
        node.exit_code = event.exit_code;
        if (
          node.spawn_time_ms !== null &&
          event.at_ms - node.spawn_time_ms < 100
        )
          state.shortLivedDescendants++;
      } else state.eventsUnmatched++;
      break;
    case "re_exec":
      if (node) {
        node.is_re_exec = true;
        node.executable = event.executable ?? node.executable;
        node.arguments = event.arguments;
        state.hasReExec = true;
      } else state.eventsUnmatched++;
      break;
    case "reparent":
      if (node) {
        node.previous_ppid = node.ppid;
        node.ppid = event.ppid;
        node.is_reparented = true;
        state.hasReparenting = true;
      } else state.eventsUnmatched++;
      break;
    case "signal":
    case "name_change":
    case "thread_create":
    case "thread_exit":
      // These events are recorded but don't modify the tree structure.
      break;
  }
};

/** Reconstruct a process tree from event-backed capture. */
export function reconstructProcessTree(
  events: readonly ProcessTreeEvent[],
  rootPid: number,
): ProcessTreeReconstruction {
  const nodes = new Map<number, ProcessNode>();
  const children = new Map<number, number[]>();
  let eventsConsumed = 0;
  const state: ProcessTreeAccumulator = {
    nodes,
    children,
    eventsUnmatched: 0,
    hasReExec: false,
    hasReparenting: false,
    shortLivedDescendants: 0,
  };

  const sorted = [...events].sort((a, b) => a.at_ms - b.at_ms);

  for (const event of sorted) {
    eventsConsumed++;
    applyProcessTreeEvent(event, state);
  }

  // Attach children to nodes
  for (const [pid, childPids] of children) {
    const node = nodes.get(pid);
    if (node) node.children = childPids;
  }

  return {
    root_pid: rootPid,
    processes: [...nodes.values()],
    events_consumed: eventsConsumed,
    events_unmatched: state.eventsUnmatched,
    short_lived_descendants: state.shortLivedDescendants,
    has_re_exec: state.hasReExec,
    has_reparenting: state.hasReparenting,
  };
}

/** Get all descendant PIDs of a given root PID. */
export function getDescendants(
  processes: readonly ProcessNode[],
  rootPid: number,
): number[] {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const visited = new Set<number>();
  const result: number[] = [];
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const node = byPid.get(pid);
    if (node) {
      for (const child of node.children) {
        if (!visited.has(child)) {
          result.push(child);
          queue.push(child);
        }
      }
    }
  }
  return result;
}

/** Check if a process tree contains a specific PID. */
export function containsProcess(
  processes: readonly ProcessNode[],
  pid: number,
): boolean {
  return processes.some((p) => p.pid === pid);
}

/** Get the maximum tree depth from the root. */
export function maxTreeDepth(
  processes: readonly ProcessNode[],
  rootPid: number,
): number {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  function depth(pid: number, visited: Set<number>): number {
    if (visited.has(pid)) return 0;
    visited.add(pid);
    const node = byPid.get(pid);
    if (!node || node.children.length === 0) return 0;
    return 1 + Math.max(...node.children.map((c) => depth(c, visited)));
  }
  return depth(rootPid, new Set());
}
