import { describe, expect, it } from "vitest";

import { hostExecutableMarking } from "./hostExecutableMarking.js";

const file = (mode: number) => ({
  mode,
  isFile: () => true,
  isSymbolicLink: () => false,
});
const directory = (mode: number) => ({
  mode,
  isFile: () => false,
  isSymbolicLink: () => false,
});
const symlink = (mode: number) => ({
  mode,
  isFile: () => false,
  isSymbolicLink: () => true,
});

describe("hostExecutableMarking", () => {
  it("marks Windows launchable files by extension because NTFS has no execute bit", () => {
    expect(
      hostExecutableMarking("C:\\scratch\\whoami.exe", file(0o666), "win32"),
    ).toBe(true);
    expect(
      hostExecutableMarking("C:\\scratch\\SETUP.CMD", file(0o444), "win32"),
    ).toBe(true);
    for (const path of [
      "tools/SETUP.EXE",
      "run.Cmd",
      "build.bat",
      "legacy.com",
    ])
      expect(hostExecutableMarking(path, file(0o666), "win32")).toBe(true);
    expect(hostExecutableMarking("readonly.exe", file(0o444), "win32")).toBe(
      true,
    );
    expect(
      hostExecutableMarking("C:\\scratch\\library.dll", file(0o666), "win32"),
    ).toBe(false);
    expect(
      hostExecutableMarking(
        "C:\\scratch\\tools.exe",
        directory(0o666),
        "win32",
      ),
    ).toBe(false);
  });

  it("does not treat other Windows filenames as executable even with execute bits", () => {
    for (const path of ["notes.txt", "README", "archive.exe.bak"])
      expect(hostExecutableMarking(path, file(0o777), "win32")).toBe(false);
  });

  it("keeps POSIX permission bits authoritative regardless of extension", () => {
    expect(hostExecutableMarking("/scratch/tool", file(0o755), "linux")).toBe(
      true,
    );
    expect(
      hostExecutableMarking("/scratch/whoami.exe", file(0o644), "darwin"),
    ).toBe(false);
  });

  it("never marks a symlink, whose target decides what runs", () => {
    for (const [path, platform] of [
      ["/scratch/current", "linux"],
      ["/scratch/current", "darwin"],
      ["C:\\scratch\\tool.exe", "win32"],
    ] as const)
      expect(hostExecutableMarking(path, symlink(0o120777), platform)).toBe(
        false,
      );
  });
});
