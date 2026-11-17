import { expect, it } from "vitest";

import { describeLaunchFailure, launcherFailureOf } from "./launchFailure.js";

it.each([
  ["ELOOP", { kind: "missing", code: "ELOOP" }],
  ["ENAMETOOLONG", { kind: "missing", code: "ENAMETOOLONG" }],
  ["ENOEXEC", { kind: "not_executable", code: "ENOEXEC" }],
  ["EISDIR", { kind: "not_executable", code: "EISDIR" }],
  ["EPERM", { kind: "not_executable", code: "EPERM" }],
  ["ENOMEM", { kind: "host-exhausted", code: "ENOMEM", resource: "memory" }],
  [
    "EMFILE",
    { kind: "host-exhausted", code: "EMFILE", resource: "file-descriptors" },
  ],
  [
    "ENFILE",
    { kind: "host-exhausted", code: "ENFILE", resource: "file-descriptors" },
  ],
  ["ETIMEDOUT", { kind: "failed", code: "ETIMEDOUT" }],
  [undefined, { kind: "failed", code: undefined }],
  [1, { kind: "failed", code: undefined }],
  ["toString", { kind: "failed", code: "toString" }],
])("classifies %j reported by the OS launcher", (code, expected) => {
  expect(
    launcherFailureOf(
      Object.assign(new Error("failed"), { code, syscall: "spawn" }),
    ),
  ).toEqual({ ...expected, executable: undefined, syscall: "spawn" });
});

it.each([
  [
    "Node spawn",
    { code: "ENOENT", syscall: "spawn /tool", path: "/tool" },
    {
      kind: "missing",
      code: "ENOENT",
      executable: "/tool",
      syscall: "spawn /tool",
    },
  ],
  [
    "Windows native launcher",
    {
      code: "EACCES",
      constraint: "Create process atomically inside owned Job Object failed",
      requestedPath: "C:\\tools\\tool.exe",
    },
    {
      kind: "not_executable",
      code: "EACCES",
      executable: "C:\\tools\\tool.exe",
      syscall: undefined,
    },
  ],
  [
    "bare Node spawn",
    { code: "ENOTDIR", syscall: "spawn" },
    {
      kind: "missing",
      code: "ENOTDIR",
      executable: undefined,
      syscall: "spawn",
    },
  ],
  [
    "Node spawn naming another path",
    { code: "ENOENT", syscall: "spawn /other", path: "/tool" },
    {
      kind: "missing",
      code: "ENOENT",
      executable: undefined,
      syscall: "spawn /other",
    },
  ],
  [
    "host-capacity spawn",
    { code: "EAGAIN", syscall: "spawn /tool", path: "/tool" },
    {
      kind: "host-exhausted",
      code: "EAGAIN",
      resource: "processes",
      executable: "/tool",
      syscall: "spawn /tool",
    },
  ],
  [
    "argument-list spawn",
    { code: "E2BIG", syscall: "spawn /tool", path: "/tool" },
    {
      kind: "argument-list",
      code: "E2BIG",
      executable: "/tool",
      syscall: "spawn /tool",
    },
  ],
  [
    "other errno spawn",
    { code: "EIO", syscall: "spawn /tool", path: "/tool" },
    {
      kind: "failed",
      code: "EIO",
      executable: "/tool",
      syscall: "spawn /tool",
    },
  ],
])("reads a %s failure and the executable it names", (_, fields, expected) => {
  expect(launcherFailureOf(Object.assign(new Error("failed"), fields))).toEqual(
    expected,
  );
});

it.each([
  ["an errno without a launcher", { code: "EPERM" }],
  ["a file read errno", { code: "ENOENT", syscall: "open", path: "/tool" }],
  [
    "a Windows host-control rejection",
    {
      code: "EACCES",
      constraint: "Create owned Job Object failed",
      requestedPath: "C:\\tools\\tool.exe",
    },
  ],
])("does not read %s as a launcher failure", (_, fields) => {
  expect(
    launcherFailureOf(Object.assign(new Error("refused"), fields)),
  ).toBeUndefined();
});

it("names the syscall only for an errno that is neither a refusal nor a constraint", () => {
  const read = (code: string) => {
    const failure = launcherFailureOf(
      Object.assign(new Error("failed"), {
        code,
        syscall: "spawn /tool",
        path: "/tool",
      }),
    );
    if (failure === undefined) throw new Error("Expected a launcher failure");
    return describeLaunchFailure(failure);
  };
  expect(read("EIO")).toBe("EIO from spawn /tool");
  expect(read("ENOENT")).toBe("ENOENT");
  expect(read("EAGAIN")).toBe("EAGAIN");
});
