import { expect, it } from "vitest";
import type { NativeCommandCapture } from "./CommandRunner.js";
import { parseDyldFileTypeRefusal } from "./NativeMachoCommandDiagnostics.js";

const capture = (stdout: string, stderr = ""): NativeCommandCapture => ({
  tool: "dyld_info",
  executable: "/usr/bin/dyld_info",
  executableSha256: "a".repeat(64),
  toolVersion: null,
  versionReason: null,
  arguments: ["-imports", "/selected/target"],
  stdout,
  stderr,
  stdoutBytes: Buffer.byteLength(stdout),
  stderrBytes: Buffer.byteLength(stderr),
  exitCode: 1,
  signal: null,
});

it.each([
  ["unknown filetype 3", "3"],
  ["unknown mh.filetype 4", "4"],
])("recognizes a sole dyld file-type refusal (%s)", (diagnostic, fileType) => {
  expect(
    parseDyldFileTypeRefusal(capture(`/selected/target:\n${diagnostic}\n`)),
  ).toEqual({ fileType, diagnostic });
});

it.each([
  ["unknown mh.filetype 4\nmalformed load command\n", ""],
  ["unknown mh.filetype 4\n", "read failed\n"],
])("keeps mixed dyld diagnostics unclassified (%s, %s)", (stdout, stderr) => {
  expect(parseDyldFileTypeRefusal(capture(stdout, stderr))).toBeNull();
});
