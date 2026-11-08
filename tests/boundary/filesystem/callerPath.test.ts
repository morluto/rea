import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { absoluteCallerPath } from "../../../src/filesystem/callerPath.js";

it("resolves absolute POSIX paths independently of an unavailable cwd", () => {
  const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
    throw new Error("working directory was removed");
  });
  try {
    expect(
      absoluteCallerPath("/cache//rea/kuna/.", { platform: "linux" }),
    ).toBe("/cache/rea/kuna/");
    expect(
      absoluteCallerPath("sample", { cwd: "/explicit", platform: "linux" }),
    ).toBe("/explicit/sample");
  } finally {
    cwd.mockRestore();
  }
});

it("keeps POSIX parent components for the filesystem to resolve", () => {
  const posix = { cwd: "/work", platform: "linux" } as const;
  expect(absoluteCallerPath("link/../sample", posix)).toBe(
    "/work/link/../sample",
  );
  expect(absoluteCallerPath("/abs/link/../sample", posix)).toBe(
    "/abs/link/../sample",
  );
  expect(absoluteCallerPath("../sample", posix)).toBe("/work/../sample");
});

it("removes only POSIX spellings that cannot change the named file", () => {
  const posix = { cwd: "/work/", platform: "darwin" } as const;
  expect(absoluteCallerPath("./module.wasm", posix)).toBe("/work/module.wasm");
  expect(absoluteCallerPath("a//./b", posix)).toBe("/work/a/b");
  expect(absoluteCallerPath("/x/./y", posix)).toBe("/x/y");
  expect(absoluteCallerPath("sample", { ...posix, cwd: "/" })).toBe("/sample");
  expect(absoluteCallerPath("/", posix)).toBe("/");
  // A trailing separator or `.` still requires a directory.
  expect(absoluteCallerPath("sample/", posix)).toBe("/work/sample/");
  expect(absoluteCallerPath("sample/.", posix)).toBe("/work/sample/");
  expect(absoluteCallerPath("a//b//", posix)).toBe("/work/a/b/");
});

it("makes a relative POSIX cwd absolute before appending the path", () => {
  const cwd = vi.spyOn(process, "cwd").mockReturnValue("/work");
  try {
    expect(
      absoluteCallerPath("sample", { cwd: "fixtures/../x", platform: "linux" }),
    ).toBe("/work/fixtures/../x/sample");
  } finally {
    cwd.mockRestore();
  }
});

it("uses lexical resolution on Windows, where it is exact", () => {
  const win32 = { cwd: "C:\\work", platform: "win32" } as const;
  expect(absoluteCallerPath("link\\..\\sample", win32)).toBe(
    "C:\\work\\sample",
  );
  expect(absoluteCallerPath("D:\\x\\..\\y", win32)).toBe("D:\\y");
});

it("normalizes separator spellings of absolute Windows paths (#4707)", () => {
  const win32 = { cwd: "C:\\work", platform: "win32" } as const;
  for (const spelling of [
    "C:\\Users\\u\\h.exe",
    "C:/Users/u/h.exe",
    "C:\\\\Users\\\\u\\\\h.exe",
    "C://Users//u//h.exe",
  ])
    expect(absoluteCallerPath(spelling, win32)).toBe("C:\\Users\\u\\h.exe");
});

const missing = () => {
  throw Object.assign(new Error("not found"), { code: "ENOENT" });
};

it("adopts the filesystem spelling of an existing Windows path (#9373)", () => {
  const onDisk = "C:\\Temp\\rea-win-test\\sample.bin";
  const canonicalPath = (path: string) =>
    path.toLowerCase() === onDisk.toLowerCase() ? onDisk : missing();
  const win32 = { cwd: "C:\\work", platform: "win32", canonicalPath } as const;
  for (const spelling of [
    "C:\\Temp\\rea-win-test\\sample.bin",
    "C:/Temp/rea-win-test/sample.bin",
    "C:\\Temp\\.\\rea-win-test\\sample.bin",
    "c:\\temp\\rea-win-test\\sample.bin",
    "C:\\TEMP\\REA-WIN-TEST\\SAMPLE.BIN",
  ])
    expect(absoluteCallerPath(spelling, win32)).toBe(onDisk);
});

it("keeps the caller spelling when the Windows lookup changes more than case", () => {
  const selected = "c:\\Links\\Tool\\sample.bin";
  for (const target of [
    // Symbolic link or junction.
    "D:\\real\\sample.bin",
    // `subst` drive.
    "C:\\Users\\u\\Links\\Tool\\sample.bin",
    // 8.3 short name expanded.
    "C:\\LinksLongName\\Tool\\sample.bin",
  ])
    expect(
      absoluteCallerPath(selected, {
        platform: "win32",
        canonicalPath: () => target,
      }),
    ).toBe(selected);
});

it("keeps the caller spelling of a Windows path that does not exist yet", () => {
  expect(
    absoluteCallerPath("c:\\Out\\Report.JSON", {
      platform: "win32",
      canonicalPath: missing,
    }),
  ).toBe("c:\\Out\\Report.JSON");
});

it.skipIf(process.platform !== "win32")(
  "folds letter case against a real NTFS file (#9373)",
  () => {
    // Hosted runners spell tmpdir with 8.3 short names, which stay unexpanded.
    const directory = realpathSync.native(
      mkdtempSync(join(tmpdir(), "rea-CallerCase-")),
    );
    try {
      const file = join(directory, "Sample.BIN");
      writeFileSync(file, "x");
      const expected = absoluteCallerPath(file);
      expect(expected.endsWith("Sample.BIN")).toBe(true);
      expect(absoluteCallerPath(file.toUpperCase())).toBe(expected);
      expect(absoluteCallerPath(file.toLowerCase())).toBe(expected);
      const output = join(directory, "New-Output.JSON");
      expect(absoluteCallerPath(output)).toBe(output);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
