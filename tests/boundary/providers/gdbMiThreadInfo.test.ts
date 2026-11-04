import { describe, expect, it } from "vitest";

import {
  gdbMiThreadInfoConfirmsStopped,
  gdbThreadInfoConfirmsAllStopped,
} from "../../../src/gdb/GdbSessionManager.js";

describe("GDB MI thread-state confirmation", () => {
  it.each([
    '7^done,threads=[{id="1",target-id="Thread 1",state="stopped"}]',
    '7^done,threads=[{id="1",target-id="Thread 1",state="stopped"},{id="2",target-id="Thread 2",state="stopped"}]',
    '7^done,threads=[{id="1",target-id="Thread 1",state="stopped"}],current-thread-id="1"',
    '7^done,threads=[{id="1",target-id="Thread 1",frame={level="0",args=[{name="i",value="10"}]},state="stopped"}]',
    '7^done,threads=[{id="1",target-id="Thread\\n1",state="stopped"}]',
    "7^done,threads=[]",
  ])("accepts explicit non-running thread states in %s", (record) => {
    expect(gdbMiThreadInfoConfirmsStopped(record)).toBe(true);
  });

  it.each([
    '7^done,threads=[{id="1",target-id="Thread 1",state="running"}]',
    '7^done,threads=[{id="1"}]',
    "7^done,threads=[{}]",
    '7^done,threads=[{id="1",target-id="Thread 1",state="sleeping"}]',
    '7^done,threads=[{id="1",target-id="Thread 1",state="stopped"}',
    '7^done,threads=[{id="1",target-id="Thread 1",state="stopped"},]',
    '7^done,threads=[{id="1",target-id="Thread 1",state="stopped",}]',
    '7^done,threads=[{id="1",target-id="Thread 1",state="stopped"}]garbage',
    '7^done,threads=[{id="1",target-id="Thread 1",state="stopped"}] junk',
    '7^done,threads=[{id="1",target-id="Thread 1",state="stopped"}],',
    '7^done,threads=[{target-id="Thread 1",state="stopped"}]',
    '7^done,threads=[{id="1",state="stopped"}]',
    '7^done,threads=[{id="1",id="2",target-id="Thread 1",state="stopped"}]',
    '7^done,threads=[{id="1",target-id="Thread 1",state="stopped"},{id="1",target-id="Thread 2",state="stopped"}]',
    '7^done,threads=[{id="1",target-id="Thread 1",state="exited"}]',
    '7^done,threads=[],current-thread-id="1"',
    '7^done,threads=[{id="1",target-id="Thread 1",state="stopped"}],current-thread-id="99"',
    '7^done,threads=[{id="1",target-id="Thread 1",state="stopped"}],current-thread-id=1',
    '7^done,threads=[{id="1",target-id="Thread 1",state="stopped"}],current-thread-id="99",current-thread-id="1"',
    '7^done,threads=[{id="1",target-id="Thread 1",state="stopped"}],current-thread-id="1",current-thread-id="99"',
    '7^done,threads=[{id="1",target-id="Thread 1",state="stopped",x=garbage}]',
    '7^done,threads=[{id="1",target-id="Thread 1",state="stopped"}],x=garbage',
    '7^done,threads=[{id="1",target-id="Thread\\q1",state="stopped"}]',
    '7^done,threads=[{id="1",target-id="Thread\n1",state="stopped"}]',
    '7^done,threads=[{id="1",target-id="Thread\u007f1",state="stopped"}]',
    '7^done,threads=[{id="1",target-id="Thread\u00851",state="stopped"}]',
  ])("rejects incomplete or non-stopped thread states in %s", (record) => {
    expect(gdbMiThreadInfoConfirmsStopped(record)).toBe(false);
  });

  it.each([
    {
      completion_status: "unknown" as const,
      output_truncated: false,
      mi: '7^done,threads=[{id="1",target-id="Thread 1",state="stopped"}]',
    },
    {
      completion_status: "complete" as const,
      output_truncated: true,
      mi: '7^done,threads=[{id="1",target-id="Thread 1",state="stopped"}]',
    },
    {
      completion_status: "complete" as const,
      output_truncated: false,
      output_invalid_utf8: true as const,
      mi: '7^done,threads=[{id="1",target-id="Thread 1",state="stopped"}]',
    },
  ])("rejects incomplete transport result %#", (result) => {
    expect(
      gdbThreadInfoConfirmsAllStopped({
        command: "-thread-info",
        records: [],
        console: "",
        target: "",
        log: "",
        output_truncated: result.output_truncated,
        completion_status: result.completion_status,
        mi: result.mi,
        ...(result.output_invalid_utf8
          ? { output_invalid_utf8: result.output_invalid_utf8 }
          : {}),
      }),
    ).toBe(false);
  });

  it("accepts a complete result only when every reported thread has stopped", () => {
    expect(
      gdbThreadInfoConfirmsAllStopped({
        command: "-thread-info",
        mi: '7^done,threads=[{id="1",target-id="Thread 1",state="stopped"}]',
        records: [],
        console: "",
        target: "",
        log: "",
        output_truncated: false,
        completion_status: "complete",
      }),
    ).toBe(true);
  });
});
