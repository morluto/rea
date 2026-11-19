import { describe, expect, it, vi } from "vitest";

import {
  posixPathCandidates,
  windowsPathCandidates,
} from "./executableSearch.js";

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

  it("skips relative entries once the working directory is removed and searches later ones", () => {
    const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("ENOENT: uv_cwd");
    });
    try {
      expect([
        ...posixPathCandidates("java", ".::/jdk/bin", {
          relativeEntries: "resolve",
        }),
      ]).toEqual([{ path: "/jdk/bin/java", relativeEntry: false }]);
      const windows = windowsPathCandidates("java", {
        PATH: "bin;C:\\jdk\\bin",
        PATHEXT: ".EXE",
      });
      if (!windows.ok) throw new Error(windows.error.extension);
      expect([...windows.value]).toEqual([
        { path: "C:\\jdk\\bin\\java.EXE", relativeEntry: false },
      ]);
    } finally {
      cwd.mockRestore();
    }
  });

  it("tries every name in an entry before the next entry", () => {
    expect([
      ...posixPathCandidates(["ghidra", "ghidraRun"], "/a:/b", {
        relativeEntries: "skip",
      }),
    ]).toEqual([
      { path: "/a/ghidra", relativeEntry: false },
      { path: "/a/ghidraRun", relativeEntry: false },
      { path: "/b/ghidra", relativeEntry: false },
      { path: "/b/ghidraRun", relativeEntry: false },
    ]);
  });
});

describe("windowsPathCandidates", () => {
  const paths = (
    ...input: Parameters<typeof windowsPathCandidates>
  ): readonly string[] => {
    const search = windowsPathCandidates(...input);
    if (!search.ok) throw new Error(search.error.extension);
    return [...search.value].map(({ path }) => path);
  };

  it("searches quoted, relative and case-insensitive PATH entries with image PATHEXT extensions", () => {
    expect(
      paths(
        "rizin",
        {
          Path: '"C:\\Program Files\\a;b";.\\bin;;"";bad"quote',
          PathExt: ".CMD;.EXE;.COM",
        },
        { cwd: "D:\\work" },
      ),
    ).toEqual([
      "C:\\Program Files\\a;b\\rizin.EXE",
      "C:\\Program Files\\a;b\\rizin.COM",
      "D:\\work\\bin\\rizin.EXE",
      "D:\\work\\bin\\rizin.COM",
    ]);
  });

  it("opens a quote only at the start of an entry, so a stray quote cannot hide later entries", () => {
    expect(
      paths(
        ["ghidra.bat"],
        { PATH: 'bad"quote;C:\\ghidra;"C:\\a;b"' },
        { allowBatch: true, cwd: "C:\\" },
      ),
    ).toEqual(["C:\\ghidra\\ghidra.bat", "C:\\a;b\\ghidra.bat"]);
  });

  it("includes batch launchers only when the caller can start them through cmd.exe", () => {
    const environment = { PATH: "C:\\tools", PATHEXT: ".BAT;.EXE" };
    expect(paths("apktool", environment, { cwd: "C:\\" })).toEqual([
      "C:\\tools\\apktool.EXE",
    ]);
    expect(
      paths("apktool", environment, { cwd: "C:\\", allowBatch: true }),
    ).toEqual(["C:\\tools\\apktool.BAT", "C:\\tools\\apktool.EXE"]);
    expect(paths("npm.cmd", environment, { cwd: "C:\\" })).toEqual([]);
  });

  it("uses the selected working drive for a root-relative command", () => {
    expect(
      paths("\\bin\\tool", { PATHEXT: ".EXE" }, { cwd: "Z:\\work" }),
    ).toEqual(["Z:\\bin\\tool.EXE"]);
    // A UNC working directory roots it at the share, as Win32 does.
    expect(
      paths(
        "\\bin\\tool",
        { PATHEXT: ".EXE" },
        { cwd: "\\\\server\\share\\work" },
      ),
    ).toEqual(["\\\\server\\share\\bin\\tool.EXE"]);
  });

  it("marks a PATH entry without a drive as relative to the working drive", () => {
    const search = windowsPathCandidates(
      "tool.exe",
      { PATH: "\\bin;D:\\tools" },
      { cwd: "Z:\\work" },
    );
    if (!search.ok) throw new Error(search.error.extension);
    expect([...search.value]).toEqual([
      { path: "Z:\\bin\\tool.exe", relativeEntry: true },
      { path: "D:\\tools\\tool.exe", relativeEntry: false },
    ]);
  });

  it("tries every launcher name in an entry before the next entry", () => {
    expect(
      paths(
        ["ghidra.bat", "ghidra.exe"],
        { PATH: "C:\\a;C:\\b" },
        { allowBatch: true, cwd: "C:\\" },
      ),
    ).toEqual([
      "C:\\a\\ghidra.bat",
      "C:\\a\\ghidra.exe",
      "C:\\b\\ghidra.bat",
      "C:\\b\\ghidra.exe",
    ]);
  });

  it("fails a search that would append an invalid PATHEXT entry, but not one with a named extension", () => {
    const environment = { PATH: "C:\\jdk\\bin", PATHEXT: ".EXE;C:\\bad" };
    expect(windowsPathCandidates("java", environment)).toEqual({
      ok: false,
      error: { kind: "invalid_extension", extension: "C:\\bad" },
    });
    expect(paths("java.exe", environment, { cwd: "C:\\" })).toEqual([
      "C:\\jdk\\bin\\java.exe",
    ]);
  });
});
