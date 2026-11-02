import { describe, expect, it } from "vitest";

import { gdbOneShotCommandMayInvalidateDetachProof } from "../../../src/gdb/GdbSessionManager.js";

describe("one-shot GDB command classification", () => {
  it.each([
    "shell sleep 3600 &",
    "sh touch /tmp/x",
    "!sleep 3600",
    "info threads &",
    "source commands.gdb",
    "sour commands.gdb",
    "sou commands.gdb",
    "so commands.gdb",
  ])(
    "treats %s as able to outlive or invalidate the detach proof",
    (command) => {
      expect(gdbOneShotCommandMayInvalidateDetachProof(command)).toBe(true);
    },
  );

  it.each(["info registers", "print &value", "bt", "s", "step", "step 2"])(
    "keeps %s eligible for the one-shot path",
    (command) => {
      expect(gdbOneShotCommandMayInvalidateDetachProof(command)).toBe(false);
    },
  );
});
