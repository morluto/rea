import { describe, expect, it } from "vitest";

import {
  diffDesktopStates,
  isWithinAny,
  type DesktopPathState,
  type DesktopWalk,
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
const walk = (
  entries: readonly (readonly [string, DesktopPathState])[],
  listed: readonly string[] = ["/h"],
): DesktopWalk => ({
  entries: new Map(entries),
  listed: new Set(listed),
  roots: new Set(["/h"]),
});

describe("diffDesktopStates", () => {
  it("reports created, deleted, modified and retyped paths in code-point order", () => {
    const { differences, unconfirmed } = diffDesktopStates(
      walk([
        ["/h/a.txt", file()],
        ["/h/b.txt", file()],
        ["/h/link", file()],
        ["/h/same.txt", file()],
      ]),
      walk([
        ["/h/a.txt", file({ mtime_ns: "2000" })],
        ["/h/link", { ...file(), type: "symlink" }],
        ["/h/same.txt", file()],
        ["/h/Z.txt", file()],
      ]),
    );
    expect(differences.map(({ path, kind }) => [path, kind])).toEqual([
      ["/h/Z.txt", "created"],
      ["/h/a.txt", "modified"],
      ["/h/b.txt", "deleted"],
      ["/h/link", "type_changed"],
    ]);
    expect(unconfirmed).toBe(0);
  });

  it("treats a rewrite with the same size as modified when the inode changes", () => {
    const { differences } = diffDesktopStates(
      walk([["/h/a", file()]]),
      walk([["/h/a", file({ inode: "1:11" })]]),
    );
    expect(differences[0]?.kind).toBe("modified");
  });

  it("ignores directory time changes caused by their entries", () => {
    expect(
      diffDesktopStates(
        walk([["/h/d", directory("1")]]),
        walk([["/h/d", directory("2")]]),
      ).differences,
    ).toEqual([]);
  });

  it("reports a file created inside a new directory when the walk listed its nearest existing ancestor", () => {
    const { differences, unconfirmed } = diffDesktopStates(
      walk([["/h", directory("1")]], ["/h"]),
      walk(
        [
          ["/h", directory("2")],
          ["/h/new", directory("2")],
          ["/h/new/file", file()],
        ],
        ["/h", "/h/new"],
      ),
    );
    expect(differences.map(({ path, kind }) => [path, kind])).toEqual([
      ["/h/new", "created"],
      ["/h/new/file", "created"],
    ]);
    expect(unconfirmed).toBe(0);
  });

  it("counts paths whose parent a walk did not list as unconfirmed, not created or deleted", () => {
    // /h/e could not be listed before and /h/d could not be listed after.
    const { differences, unconfirmed } = diffDesktopStates(
      walk(
        [
          ["/h", directory("1")],
          ["/h/d", directory("1")],
          ["/h/d/old", file()],
          ["/h/e", directory("1")],
        ],
        ["/h", "/h/d"],
      ),
      walk(
        [
          ["/h", directory("1")],
          ["/h/d", directory("1")],
          ["/h/e", directory("1")],
          ["/h/e/new", file()],
        ],
        ["/h", "/h/e"],
      ),
    );
    expect(differences).toEqual([]);
    expect(unconfirmed).toBe(2);
  });
});

describe("isWithinAny", () => {
  it("matches a root and its descendants but not siblings sharing a prefix", () => {
    expect(isWithinAny("/h/.config/app", ["/h/.config/app"])).toBe(true);
    expect(isWithinAny("/h/.config/app/x", ["/h/.config/app"])).toBe(true);
    expect(isWithinAny("/h/.config/apple", ["/h/.config/app"])).toBe(false);
  });
});
