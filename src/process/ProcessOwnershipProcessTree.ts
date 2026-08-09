import type { ProcessTableEntry } from "./ProcessOwnership.js";

/** Exclude process-table entries that the operating system has already reaped. */
export const liveProcesses = (
  members: readonly ProcessTableEntry[],
): readonly ProcessTableEntry[] =>
  members.filter(({ state }) => !state.startsWith("Z"));

/** Return every live-table descendant of a launcher in breadth-first order. */
export const descendantsOf = (
  launcherPid: number,
  processes: readonly ProcessTableEntry[],
): ProcessTableEntry[] => {
  const childrenByParent = new Map<number, ProcessTableEntry[]>();
  for (const process of processes) {
    const siblings = childrenByParent.get(process.parentPid) ?? [];
    siblings.push(process);
    childrenByParent.set(process.parentPid, siblings);
  }
  const descendants: ProcessTableEntry[] = [];
  const pending = [...(childrenByParent.get(launcherPid) ?? [])];
  const visited = new Set<number>([launcherPid]);
  for (const process of pending) {
    if (visited.has(process.pid)) continue;
    visited.add(process.pid);
    descendants.push(process);
    pending.push(...(childrenByParent.get(process.pid) ?? []));
  }
  return descendants;
};
