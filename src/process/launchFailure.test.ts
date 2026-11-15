import { expect, it } from "vitest";

import {
  classifyLaunchFailure,
  classifyLaunchFailureCode,
  launcherRefusalOf,
} from "./launchFailure.js";

it.each([
  ["ENOENT", "missing"],
  ["ENOTDIR", "missing"],
  ["ELOOP", "missing"],
  ["ENAMETOOLONG", "missing"],
  ["EACCES", "not_executable"],
  ["EPERM", "not_executable"],
  ["ENOEXEC", "not_executable"],
  ["EISDIR", "not_executable"],
])("classifies spawn %s as %s", (code, kind) => {
  expect(classifyLaunchFailureCode(code)).toEqual({ kind, code });
  expect(
    classifyLaunchFailure(Object.assign(new Error(code), { code })),
  ).toEqual({ kind, code });
});

it.each([["EAGAIN"], ["EMFILE"], ["ETIMEDOUT"], [1], [null], ["toString"]])(
  "leaves %j unclassified",
  (code) => {
    expect(classifyLaunchFailureCode(code)).toBeUndefined();
  },
);

it.each([
  [
    "Node spawn",
    { code: "ENOENT", syscall: "spawn /tool", path: "/tool" },
    { kind: "missing", code: "ENOENT", executable: "/tool" },
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
    },
  ],
  [
    "bare Node spawn",
    { code: "ENOTDIR", syscall: "spawn" },
    { kind: "missing", code: "ENOTDIR", executable: undefined },
  ],
  [
    "Node spawn naming another path",
    { code: "ENOENT", syscall: "spawn /other", path: "/tool" },
    { kind: "missing", code: "ENOENT", executable: undefined },
  ],
])("reads a %s refusal and the executable it names", (_, fields, expected) => {
  expect(
    launcherRefusalOf(Object.assign(new Error("refused"), fields)),
  ).toEqual(expected);
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
  [
    "a launcher error whose errno is not a refusal",
    { code: "EAGAIN", syscall: "spawn /tool", path: "/tool" },
  ],
])("does not read %s as a launcher refusal", (_, fields) => {
  expect(
    launcherRefusalOf(Object.assign(new Error("refused"), fields)),
  ).toBeUndefined();
});
