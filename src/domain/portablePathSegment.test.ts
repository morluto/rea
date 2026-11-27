import { describe, expect, it } from "vitest";

import {
  isPortablePathSegment,
  windowsDestinationPathIssue,
} from "./portablePathSegment.js";

describe("windowsDestinationPathIssue", () => {
  it.each([
    ["dir\\file.bin", "backslash"],
    ["a\\b:c\t", "backslash"],
    ["a:b", "colon"],
    ["hello.txt:hidden", "colon"],
    ["dir/file:stream\r", "colon"],
    ["Folder/Icon\r", "control"],
    ["Fold\ter/file.txt", "control"],
    ["data/readme.txt", undefined],
  ] as const)("classifies %j as %j", (path, issue) => {
    expect(windowsDestinationPathIssue(path)).toBe(issue);
  });
});

describe("isPortablePathSegment", () => {
  it.each([
    "readme.txt",
    "a.bin",
    ".hidden",
    "my file.bin",
    "console.txt",
    "com10.bin",
    "nul_data",
    "con file.txt",
    "a.con",
  ])("accepts portable segment %j", (segment) => {
    expect(isPortablePathSegment(segment)).toBe(true);
  });

  it.each([
    "",
    ".",
    "..",
    "a/b",
    "a\\b",
    "a\0b",
    "a:b",
    "hello.txt:hidden",
    "a\tb",
    "a\rb",
    "a*b",
    "a?b",
    'a"b',
    "a<b",
    "a>b",
    "a|b",
    "CON",
    "con",
    "Con.txt",
    "PRN",
    "AUX.bin",
    "NUL",
    "nul .txt",
    "COM0",
    "com1",
    "COM9.dat",
    "LPT0",
    "lpt9.bin",
    "COM¹.txt",
    "lpt³",
    "trailing.",
    "trailing ",
  ])("rejects non-portable segment %j", (segment) => {
    expect(isPortablePathSegment(segment)).toBe(false);
  });
});
