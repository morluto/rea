import { describe, expect, it, vi } from "vitest";

import { posixPathCandidates } from "./executableSearch.js";

describe("posixPathCandidates", () => {
  it("searches PATH in order, resolving empty and relative entries against the working directory", () => {
    expect([
      ...posixPathCandidates("tool", "/usr/bin::bin:/opt/./x/../y/", {
        relativeEntries: "resolve",
        workingDirectory: "/work",
      }),
    ]).toEqual([
      { path: "/usr/bin/tool", relativeEntry: false },
      { path: "/work/tool", relativeEntry: true },
      { path: "/work/bin/tool", relativeEntry: true },
      // `..` stays for the filesystem to resolve after a symbolic link.
      { path: "/opt/x/../y/tool", relativeEntry: false },
    ]);
  });

  it("leaves out entries that depend on the working directory when asked", () => {
    expect([
      ...posixPathCandidates("tool", ":bin:/usr/bin", {
        relativeEntries: "skip",
      }),
    ]).toEqual([{ path: "/usr/bin/tool", relativeEntry: false }]);
    // An empty PATH is one empty entry: the working directory.
    expect([
      ...posixPathCandidates("tool", "", { relativeEntries: "skip" }),
    ]).toEqual([]);
    expect([
      ...posixPathCandidates("tool", "", {
        relativeEntries: "resolve",
        workingDirectory: "/work",
      }),
    ]).toEqual([{ path: "/work/tool", relativeEntry: true }]);
  });

  it("resolves no entry after the one the caller stops at", () => {
    // Resolving `.` without a working directory reads this process's
    // directory, which may have been removed; an earlier match must not
    // depend on it.
    const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("ENOENT: uv_cwd");
    });
    try {
      const [first] = posixPathCandidates("java", "/jdk/bin:.", {
        relativeEntries: "resolve",
      });
      expect(first).toEqual({ path: "/jdk/bin/java", relativeEntry: false });
      expect(cwd).not.toHaveBeenCalled();
    } finally {
      cwd.mockRestore();
    }
  });
});
