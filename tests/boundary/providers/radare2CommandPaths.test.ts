import { win32 } from "node:path";

import { describe, expect, it } from "vitest";

import { radare2Command } from "../../../src/radare2/Radare2Command.js";
import { radiff2Command } from "../../../src/radare2/Radiff2Command.js";

// POSIX resolves `..` after following the preceding symlink, so a lexical
// rewrite of `link/../sample` can name a different file than the caller chose.
const POSIX_SELECTED_PATH = "/work/link/../sample";
const expectedPath = (selected: string): string =>
  process.platform === "win32" ? win32.resolve(selected) : selected;

describe("radare2 command paths", () => {
  it("passes the caller-selected file without rewriting symlink-relative parents", () => {
    const command = radare2Command({
      path: POSIX_SELECTED_PATH,
      command: "ij",
    });

    expect(command.at(-1)).toBe(expectedPath(POSIX_SELECTED_PATH));
  });

  it("compares both caller-selected files without rewriting symlink-relative parents", () => {
    const second = "/work/other-link/../sample-b";
    const command = radiff2Command({
      path_a: POSIX_SELECTED_PATH,
      path_b: second,
      operation: "functions",
    });

    expect(command.slice(-2)).toEqual([
      expectedPath(POSIX_SELECTED_PATH),
      expectedPath(second),
    ]);
  });
});
