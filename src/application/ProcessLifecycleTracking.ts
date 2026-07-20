import type {
  ProcessLifecycleEvent,
  ProcessSample,
} from "../domain/processCapture.js";

/** Mutable observation state owned by one bounded process sampler. */
export interface ProcessLifecycleState {
  readonly previous: Map<number, ProcessSample>;
  readonly misses: Map<number, number>;
}

/** Record spawn, reparent, and confirmed-exit transitions for one sample. */
export const recordProcessLifecycle = (options: {
  readonly values: readonly ProcessSample[];
  readonly events: ProcessLifecycleEvent[];
  readonly state: ProcessLifecycleState;
  readonly limit: number;
  readonly elapsedMs: number;
}): boolean => {
  const { values, events, state, limit, elapsedMs } = options;
  const current = new Set(values.map(({ pid }) => pid));
  let complete = true;
  for (const value of values) {
    const prior = state.previous.get(value.pid);
    if (prior === undefined)
      complete =
        appendEvent(events, limit, {
          at_ms: value.at_ms,
          type: "spawned",
          pid: value.pid,
          parent_pid: value.parent_pid,
          previous_parent_pid: null,
          signal: null,
        }) && complete;
    else if (prior.parent_pid !== value.parent_pid)
      complete =
        appendEvent(events, limit, {
          at_ms: value.at_ms,
          type: "reparented",
          pid: value.pid,
          parent_pid: value.parent_pid,
          previous_parent_pid: prior.parent_pid,
          signal: null,
        }) && complete;
    state.previous.set(value.pid, value);
    state.misses.delete(value.pid);
  }
  for (const [pid, prior] of state.previous) {
    if (current.has(pid)) continue;
    const missed = (state.misses.get(pid) ?? 0) + 1;
    state.misses.set(pid, missed);
    if (missed < 2) continue;
    complete =
      appendEvent(events, limit, {
        at_ms: elapsedMs,
        type: "exited",
        pid,
        parent_pid: null,
        previous_parent_pid: prior.parent_pid,
        signal: null,
      }) && complete;
    state.previous.delete(pid);
    state.misses.delete(pid);
  }
  return complete;
};

const appendEvent = (
  events: ProcessLifecycleEvent[],
  limit: number,
  event: Omit<ProcessLifecycleEvent, "sequence">,
): boolean => {
  if (events.length >= limit) return false;
  events.push({ ...event, sequence: events.length });
  return true;
};
