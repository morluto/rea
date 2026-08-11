import { describe, expect, it } from "vitest";

import {
  containsProcess,
  getDescendants,
  maxTreeDepth,
  reconstructProcessTree,
  type ProcessTreeEvent,
} from "./eventProcessTree.js";

describe("event-backed process tree reconstruction", () => {
  it("reconstructs a simple process tree", () => {
    const events: ProcessTreeEvent[] = [
      {
        sequence: 0,
        at_ms: 0,
        type: "spawn",
        pid: 1,
        ppid: 0,
        process_name: "root",
        executable: "/root",
        arguments: [],
        previous_pid: null,
        previous_ppid: null,
        exit_code: null,
        signal: null,
        tid: null,
      },
      {
        sequence: 1,
        at_ms: 10,
        type: "spawn",
        pid: 2,
        ppid: 1,
        process_name: "child",
        executable: "/child",
        arguments: [],
        previous_pid: null,
        previous_ppid: null,
        exit_code: null,
        signal: null,
        tid: null,
      },
      {
        sequence: 2,
        at_ms: 20,
        type: "exit",
        pid: 2,
        ppid: 1,
        process_name: "child",
        executable: null,
        arguments: [],
        previous_pid: null,
        previous_ppid: null,
        exit_code: 0,
        signal: null,
        tid: null,
      },
      {
        sequence: 3,
        at_ms: 30,
        type: "exit",
        pid: 1,
        ppid: 0,
        process_name: "root",
        executable: null,
        arguments: [],
        previous_pid: null,
        previous_ppid: null,
        exit_code: 0,
        signal: null,
        tid: null,
      },
    ];
    const result = reconstructProcessTree(events, 1);
    expect(result.processes).toHaveLength(2);
    expect(result.events_consumed).toBe(4);
    expect(result.events_unmatched).toBe(0);
    expect(result.short_lived_descendants).toBe(2);
  });

  it("detects short-lived descendants", () => {
    const events: ProcessTreeEvent[] = [
      {
        sequence: 0,
        at_ms: 0,
        type: "spawn",
        pid: 1,
        ppid: 0,
        process_name: "root",
        executable: "/root",
        arguments: [],
        previous_pid: null,
        previous_ppid: null,
        exit_code: null,
        signal: null,
        tid: null,
      },
      {
        sequence: 1,
        at_ms: 10,
        type: "spawn",
        pid: 2,
        ppid: 1,
        process_name: "short",
        executable: "/short",
        arguments: [],
        previous_pid: null,
        previous_ppid: null,
        exit_code: null,
        signal: null,
        tid: null,
      },
      {
        sequence: 2,
        at_ms: 11,
        type: "exit",
        pid: 2,
        ppid: 1,
        process_name: "short",
        executable: null,
        arguments: [],
        previous_pid: null,
        previous_ppid: null,
        exit_code: 0,
        signal: null,
        tid: null,
      },
    ];
    const result = reconstructProcessTree(events, 1);
    expect(result.short_lived_descendants).toBe(1);
  });
});

describe("event-backed process tree transitions", () => {
  it("detects re-exec", () => {
    const events: ProcessTreeEvent[] = [
      {
        sequence: 0,
        at_ms: 0,
        type: "spawn",
        pid: 1,
        ppid: 0,
        process_name: "root",
        executable: "/root",
        arguments: [],
        previous_pid: null,
        previous_ppid: null,
        exit_code: null,
        signal: null,
        tid: null,
      },
      {
        sequence: 1,
        at_ms: 10,
        type: "re_exec",
        pid: 1,
        ppid: 0,
        process_name: "root",
        executable: "/newroot",
        arguments: ["--new"],
        previous_pid: null,
        previous_ppid: null,
        exit_code: null,
        signal: null,
        tid: null,
      },
    ];
    const result = reconstructProcessTree(events, 1);
    expect(result.has_re_exec).toBe(true);
    const root = result.processes.find((p) => p.pid === 1)!;
    expect(root.is_re_exec).toBe(true);
    expect(root.executable).toBe("/newroot");
  });

  it("detects reparenting", () => {
    const events: ProcessTreeEvent[] = [
      {
        sequence: 0,
        at_ms: 0,
        type: "spawn",
        pid: 1,
        ppid: 0,
        process_name: "root",
        executable: "/root",
        arguments: [],
        previous_pid: null,
        previous_ppid: null,
        exit_code: null,
        signal: null,
        tid: null,
      },
      {
        sequence: 1,
        at_ms: 10,
        type: "spawn",
        pid: 2,
        ppid: 1,
        process_name: "child",
        executable: "/child",
        arguments: [],
        previous_pid: null,
        previous_ppid: null,
        exit_code: null,
        signal: null,
        tid: null,
      },
      {
        sequence: 2,
        at_ms: 20,
        type: "reparent",
        pid: 2,
        ppid: 0,
        process_name: "child",
        executable: null,
        arguments: [],
        previous_pid: null,
        previous_ppid: 1,
        exit_code: null,
        signal: null,
        tid: null,
      },
    ];
    const result = reconstructProcessTree(events, 1);
    expect(result.has_reparenting).toBe(true);
    const child = result.processes.find((p) => p.pid === 2)!;
    expect(child.is_reparented).toBe(true);
    expect(child.previous_ppid).toBe(1);
    expect(child.ppid).toBe(0);
  });

  it("reports unmatched events for unknown exits", () => {
    const events: ProcessTreeEvent[] = [
      {
        sequence: 0,
        at_ms: 0,
        type: "exit",
        pid: 999,
        ppid: null,
        process_name: null,
        executable: null,
        arguments: [],
        previous_pid: null,
        previous_ppid: null,
        exit_code: 1,
        signal: null,
        tid: null,
      },
    ];
    const result = reconstructProcessTree(events, 1);
    expect(result.events_unmatched).toBe(1);
    expect(result.processes).toHaveLength(0);
  });
});

describe("event-backed process tree queries", () => {
  it("gets descendants", () => {
    const events: ProcessTreeEvent[] = [
      {
        sequence: 0,
        at_ms: 0,
        type: "spawn",
        pid: 1,
        ppid: 0,
        process_name: "root",
        executable: "/root",
        arguments: [],
        previous_pid: null,
        previous_ppid: null,
        exit_code: null,
        signal: null,
        tid: null,
      },
      {
        sequence: 1,
        at_ms: 10,
        type: "spawn",
        pid: 2,
        ppid: 1,
        process_name: "child1",
        executable: "/c1",
        arguments: [],
        previous_pid: null,
        previous_ppid: null,
        exit_code: null,
        signal: null,
        tid: null,
      },
      {
        sequence: 2,
        at_ms: 20,
        type: "spawn",
        pid: 3,
        ppid: 2,
        process_name: "grandchild",
        executable: "/gc",
        arguments: [],
        previous_pid: null,
        previous_ppid: null,
        exit_code: null,
        signal: null,
        tid: null,
      },
    ];
    const result = reconstructProcessTree(events, 1);
    const descendants = getDescendants(result.processes, 1);
    expect(descendants).toHaveLength(2);
    expect(descendants).toContain(2);
    expect(descendants).toContain(3);
  });

  it("checks process containment", () => {
    const events: ProcessTreeEvent[] = [
      {
        sequence: 0,
        at_ms: 0,
        type: "spawn",
        pid: 1,
        ppid: 0,
        process_name: "root",
        executable: "/root",
        arguments: [],
        previous_pid: null,
        previous_ppid: null,
        exit_code: null,
        signal: null,
        tid: null,
      },
    ];
    const result = reconstructProcessTree(events, 1);
    expect(containsProcess(result.processes, 1)).toBe(true);
    expect(containsProcess(result.processes, 999)).toBe(false);
  });
});

describe("event-backed process tree depth and types", () => {
  it("computes max tree depth", () => {
    const events: ProcessTreeEvent[] = [
      {
        sequence: 0,
        at_ms: 0,
        type: "spawn",
        pid: 1,
        ppid: 0,
        process_name: "root",
        executable: "/root",
        arguments: [],
        previous_pid: null,
        previous_ppid: null,
        exit_code: null,
        signal: null,
        tid: null,
      },
      {
        sequence: 1,
        at_ms: 10,
        type: "spawn",
        pid: 2,
        ppid: 1,
        process_name: "child",
        executable: "/c",
        arguments: [],
        previous_pid: null,
        previous_ppid: null,
        exit_code: null,
        signal: null,
        tid: null,
      },
      {
        sequence: 2,
        at_ms: 20,
        type: "spawn",
        pid: 3,
        ppid: 2,
        process_name: "gc",
        executable: "/gc",
        arguments: [],
        previous_pid: null,
        previous_ppid: null,
        exit_code: null,
        signal: null,
        tid: null,
      },
    ];
    const result = reconstructProcessTree(events, 1);
    expect(maxTreeDepth(result.processes, 1)).toBe(2);
  });
});
