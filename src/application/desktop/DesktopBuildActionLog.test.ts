import { describe, expect, it } from "vitest";

import {
  BuildComputerActionLog,
  LOGGED_ACTIONS,
  LOGGED_LIST_ITEMS,
  LOGGED_TEXT_BYTES,
} from "./DesktopBuildActionLog.js";

describe("build computer action log", () => {
  it("cuts each list and string argument, and names only what it cut", () => {
    const log = new BuildComputerActionLog();
    const path = Array.from({ length: 3 * LOGGED_LIST_ITEMS }, (_, at) => [
      at,
      at,
    ]);
    log.begin("drag", "computer_drag", { path, button: "left" });
    // Two-byte characters, so the cut must not split one.
    log.begin("type", "computer_type", { text: "é".repeat(LOGGED_TEXT_BYTES) });
    log.begin("key", "computer_key", { keys: ["Control", "x".repeat(2000)] });
    log.begin("click", "computer_click", { x: 1, y: 2 });
    expect(log.entries).toEqual([
      expect.objectContaining({
        arguments: { path: path.slice(0, LOGGED_LIST_ITEMS), button: "left" },
        truncated_arguments: ["path"],
        outcome: "pending",
      }),
      expect.objectContaining({
        arguments: { text: "é".repeat(LOGGED_TEXT_BYTES / 2) },
        truncated_arguments: ["text"],
      }),
      expect.objectContaining({
        arguments: { keys: ["Control", "x".repeat(LOGGED_TEXT_BYTES)] },
        truncated_arguments: ["keys"],
      }),
      expect.not.objectContaining({ truncated_arguments: expect.anything() }),
    ]);
  });

  it("records the outcome of an action dropped while it was pending", () => {
    const log = new BuildComputerActionLog();
    const slow = log.begin("key", "computer_key", { keys: ["Control", "s"] });
    for (let index = 0; index < LOGGED_ACTIONS; index += 1)
      log.begin("wait", "computer_wait", { ms: 1 }).settle("applied");
    expect(log.dropped).toBe(1);
    slow.settle("applied");
    expect(log.lastApplied).toEqual({ key: 0, wait: LOGGED_ACTIONS });
    expect(log.entries).toHaveLength(LOGGED_ACTIONS);
    expect(log.entries.every((entry) => entry.action === "wait")).toBe(true);
  });
});
