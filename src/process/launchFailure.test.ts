import { expect, it } from "vitest";

import {
  classifyLaunchFailure,
  classifyLaunchFailureCode,
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
