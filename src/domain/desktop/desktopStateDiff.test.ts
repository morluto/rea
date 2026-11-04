import { describe, expect, it } from "vitest";

import {
  diffDesktopStates,
  isWithinAny,
  type DesktopPathState,
} from "./desktopStateDiff.js";

const file = (overrides: Partial<DesktopPathState> = {}): DesktopPathState => ({
  type: "file",
  size: 4,
  mode: 0o644,
  mtime_ns: "1000",
  inode: "1:10",
  ...overrides,
});
const directory = (mtime: string): DesktopPathState => ({
  type: "directory",
  size: 4096,
  mode: 0o755,
  mtime_ns: mtime,
  inode: "1:2",
});

describe("diffDesktopStates", () => {
  it("reports created, deleted, modified and retyped paths in code-point order", () => {
    const before = new Map<string, DesktopPathState>([
      ["/h/a.txt", file()],
      ["/h/b.txt", file()],
      ["/h/link", file()],
      ["/h/same.txt", file()],
    ]);
    const after = new Map<string, DesktopPathState>([
      ["/h/a.txt", file({ mtime_ns: "2000" })],
      ["/h/link", { ...file(), type: "symlink" }],
      ["/h/same.txt", file()],
      ["/h/Z.txt", file()],
    ]);
    expect(
      diffDesktopStates(before, after).map(({ path, kind }) => [path, kind]),
    ).toEqual([
      ["/h/Z.txt", "created"],
      ["/h/a.txt", "modified"],
      ["/h/b.txt", "deleted"],
      ["/h/link", "type_changed"],
    ]);
  });

  it("treats a rewrite with the same size as modified when the inode changes", () => {
    const [change] = diffDesktopStates(
      new Map([["/h/a", file()]]),
      new Map([["/h/a", file({ inode: "1:11" })]]),
    );
    expect(change?.kind).toBe("modified");
  });

  it("ignores directory time changes caused by their entries", () => {
    expect(
      diffDesktopStates(
        new Map([["/h", directory("1")]]),
        new Map([["/h", directory("2")]]),
      ),
    ).toEqual([]);
  });
});

describe("isWithinAny", () => {
  it("matches a root and its descendants but not siblings sharing a prefix", () => {
    expect(isWithinAny("/h/.config/app", ["/h/.config/app"])).toBe(true);
    expect(isWithinAny("/h/.config/app/x", ["/h/.config/app"])).toBe(true);
    expect(isWithinAny("/h/.config/apple", ["/h/.config/app"])).toBe(false);
  });
});
