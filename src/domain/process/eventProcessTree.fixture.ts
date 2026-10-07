import type { ProcessNode, ProcessTreeEvent } from "./eventProcessTree.js";

/**
 * Defaults shared by every fixture event. Tests vary only the fields they are
 * actually asserting on, so a tree reads as the sequence of transitions under
 * test rather than thirteen repeated literal fields per event.
 */
const eventDefaults: {
  arguments: string[];
  previous_pid: number | null;
  previous_ppid: number | null;
  exit_code: number | null;
  signal: number | null;
  tid: number | null;
} = {
  arguments: [],
  previous_pid: null,
  previous_ppid: null,
  exit_code: null,
  signal: null,
  tid: null,
};

/** One `spawn` event, numbering itself from the sequence given. */
export const spawnEvent = (event: {
  sequence: number;
  at_ms?: number;
  pid: number;
  ppid: number;
  process_name: string;
  executable?: string | null;
  arguments?: string[];
}): ProcessTreeEvent => ({
  ...eventDefaults,
  at_ms: event.at_ms ?? event.sequence * 10,
  type: "spawn",
  executable: event.executable ?? `/${event.process_name}`,
  ...event,
});

/** One `exit` event. */
export const exitEvent = (event: {
  sequence: number;
  at_ms?: number;
  pid: number;
  ppid: number | null;
  process_name: string | null;
  exit_code?: number;
}): ProcessTreeEvent => ({
  ...eventDefaults,
  at_ms: event.at_ms ?? event.sequence * 10,
  type: "exit",
  executable: null,
  exit_code: 0,
  ...event,
});

/** One `re_exec` event, which keeps the pid and replaces the executable. */
export const reExecEvent = (event: {
  sequence: number;
  at_ms?: number;
  pid: number;
  ppid: number;
  process_name: string;
  executable: string;
  arguments?: string[];
}): ProcessTreeEvent => ({
  ...eventDefaults,
  at_ms: event.at_ms ?? event.sequence * 10,
  type: "re_exec",
  previous_pid: null,
  ...event,
});

/** One `reparent` event, which records the pid the process was adopted from. */
export const reparentEvent = (event: {
  sequence: number;
  at_ms?: number;
  pid: number;
  ppid: number;
  process_name: string;
  previous_ppid: number;
}): ProcessTreeEvent => ({
  ...eventDefaults,
  at_ms: event.at_ms ?? event.sequence * 10,
  type: "reparent",
  executable: null,
  ...event,
});

/** A reconstructed node, defaulting to a childless process with no lifecycle. */
export const processNode = (node: {
  pid: number;
  ppid: number | null;
  process_name: string;
  children?: number[];
}): ProcessNode => ({
  executable: null,
  arguments: [],
  spawn_time_ms: null,
  exit_time_ms: null,
  exit_code: null,
  is_re_exec: false,
  is_reparented: false,
  previous_ppid: null,
  ...node,
  children: node.children ?? [],
});

/** The common `spawn` of a root process at pid 1. */
export const rootSpawn = (sequence = 0): ProcessTreeEvent =>
  spawnEvent({ sequence, pid: 1, ppid: 0, process_name: "root" });
