import { describe, expect, it } from "vitest";

import {
  containsProcess,
  getDescendants,
  maxTreeDepth,
  reconstructProcessTree,
  type ProcessTreeEvent,
} from "./eventProcessTree.js";
import {
  exitEvent,
  processNode,
  reExecEvent,
  reparentEvent,
  rootSpawn,
  spawnEvent,
} from "./eventProcessTree.fixture.js";

describe("event-backed process tree reconstruction", () => {
  it("walks trees larger than ten thousand nodes", () => {
    const childPids = Array.from({ length: 10_001 }, (_, index) => index + 2);
    const root = processNode({
      pid: 1,
      ppid: null,
      process_name: "root",
      children: childPids,
    });
    const children = childPids.map((pid) =>
      processNode({ pid, ppid: 1, process_name: "root" }),
    );

    expect(maxTreeDepth([root, ...children], 1)).toBe(1);
    expect(getDescendants([root, ...children], 1)).toHaveLength(
      childPids.length,
    );
  });

  it("reconstructs a simple process tree", () => {
    const events: ProcessTreeEvent[] = [
      rootSpawn(0),
      spawnEvent({
        sequence: 1,
        pid: 2,
        ppid: 1,
        process_name: "child",
        executable: "/child",
      }),
      exitEvent({
        sequence: 2,
        at_ms: 20,
        pid: 2,
        ppid: 1,
        process_name: "child",
      }),
      exitEvent({
        sequence: 3,
        at_ms: 30,
        pid: 1,
        ppid: 0,
        process_name: "root",
      }),
    ];
    const result = reconstructProcessTree(events, 1);
    expect(result.processes).toHaveLength(2);
    expect(result.events_consumed).toBe(4);
    expect(result.events_unmatched).toBe(0);
    expect(result.short_lived_descendants).toBe(2);
  });
});

describe("short-lived process descendants", () => {
  it("detects short-lived descendants", () => {
    const events: ProcessTreeEvent[] = [
      rootSpawn(0),
      spawnEvent({
        sequence: 1,
        pid: 2,
        ppid: 1,
        process_name: "short",
        executable: "/short",
      }),
      exitEvent({
        sequence: 2,
        at_ms: 11,
        pid: 2,
        ppid: 1,
        process_name: "short",
      }),
    ];
    const result = reconstructProcessTree(events, 1);
    expect(result.short_lived_descendants).toBe(1);
  });
});

describe("event-backed process tree transitions", () => {
  it("detects re-exec", () => {
    const events: ProcessTreeEvent[] = [
      rootSpawn(0),
      reExecEvent({
        sequence: 1,
        pid: 1,
        ppid: 0,
        process_name: "root",
        executable: "/newroot",
        arguments: ["--new"],
      }),
    ];
    const result = reconstructProcessTree(events, 1);
    expect(result.has_re_exec).toBe(true);
    const root = result.processes.find((p) => p.pid === 1);
    expect(root?.is_re_exec).toBe(true);
    expect(root?.executable).toBe("/newroot");
  });

  it("detects reparenting", () => {
    const events: ProcessTreeEvent[] = [
      rootSpawn(0),
      spawnEvent({
        sequence: 1,
        pid: 2,
        ppid: 1,
        process_name: "child",
        executable: "/child",
      }),
      reparentEvent({
        sequence: 2,
        pid: 2,
        ppid: 0,
        process_name: "child",
        previous_ppid: 1,
      }),
    ];
    const result = reconstructProcessTree(events, 1);
    expect(result.has_reparenting).toBe(true);
    const child = result.processes.find((p) => p.pid === 2);
    expect(child?.is_reparented).toBe(true);
    expect(child?.previous_ppid).toBe(1);
    expect(child?.ppid).toBe(0);
  });

  it("reports unmatched events for unknown exits", () => {
    const events: ProcessTreeEvent[] = [
      exitEvent({
        sequence: 0,
        at_ms: 0,
        pid: 999,
        ppid: null,
        process_name: null,
        exit_code: 1,
      }),
    ];
    const result = reconstructProcessTree(events, 1);
    expect(result.events_unmatched).toBe(1);
    expect(result.processes).toHaveLength(0);
  });
});

describe("event-backed process tree queries", () => {
  it("gets descendants", () => {
    const events: ProcessTreeEvent[] = [
      rootSpawn(0),
      spawnEvent({
        sequence: 1,
        pid: 2,
        ppid: 1,
        process_name: "child1",
        executable: "/c1",
      }),
      spawnEvent({
        sequence: 2,
        pid: 3,
        ppid: 2,
        process_name: "grandchild",
        executable: "/gc",
      }),
    ];
    const result = reconstructProcessTree(events, 1);
    const descendants = getDescendants(result.processes, 1);
    expect(descendants).toHaveLength(2);
    expect(descendants).toContain(2);
    expect(descendants).toContain(3);
  });

  it("checks process containment", () => {
    const events: ProcessTreeEvent[] = [rootSpawn(0)];
    const result = reconstructProcessTree(events, 1);
    expect(containsProcess(result.processes, 1)).toBe(true);
    expect(containsProcess(result.processes, 999)).toBe(false);
  });
});

describe("event-backed process tree depth and types", () => {
  it("computes max tree depth", () => {
    const events: ProcessTreeEvent[] = [
      rootSpawn(0),
      spawnEvent({
        sequence: 1,
        pid: 2,
        ppid: 1,
        process_name: "child",
        executable: "/c",
      }),
      spawnEvent({
        sequence: 2,
        pid: 3,
        ppid: 2,
        process_name: "gc",
        executable: "/gc",
      }),
    ];
    const result = reconstructProcessTree(events, 1);
    expect(maxTreeDepth(result.processes, 1)).toBe(2);
  });
});
