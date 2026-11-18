import { expect, it } from "vitest";

import {
  deriveDebugFileLookupPaths,
  elfDebugLinkSchema,
  ELF_DEBUG_LINK_LIMITATIONS,
} from "./elfDebugLink.js";

const digest = "ab".repeat(32);

it("keeps parent-directory segments in conventional lookup strings", () => {
  expect(
    deriveDebugFileLookupPaths({
      binaryPath: "/var/tmp/../lib/prog",
      debuglinkName: "prog.debug",
      buildIdHex: "abcd",
      altBuildIdHex: "abcd",
    }),
  ).toEqual([
    {
      kind: "build_id",
      path: "/usr/lib/debug/.build-id/ab/cd.debug",
      trust: "observed-untrusted",
    },
    {
      kind: "debug_subdirectory",
      path: "/var/tmp/../lib/.debug/prog.debug",
      trust: "observed-untrusted",
    },
    {
      kind: "global_debug_directory",
      path: "/usr/lib/debug/var/tmp/../lib/prog.debug",
      trust: "observed-untrusted",
    },
    {
      kind: "alt_build_id",
      path: "/usr/lib/debug/.build-id/ab/cd.debug",
      trust: "observed-untrusted",
    },
  ]);
});

const directoryStrings = (binaryPath: string) =>
  deriveDebugFileLookupPaths({
    binaryPath,
    debuglinkName: "prog.debug",
    buildIdHex: null,
    altBuildIdHex: null,
  }).map((entry) => entry.path);

it("uses the directory of a POSIX image path", () => {
  expect(directoryStrings("/opt/app/bin/prog")).toEqual([
    "/opt/app/bin/.debug/prog.debug",
    "/usr/lib/debug/opt/app/bin/prog.debug",
  ]);
  expect(directoryStrings("/prog")).toEqual([
    "/.debug/prog.debug",
    "/usr/lib/debug/prog.debug",
  ]);
  // A POSIX file name may contain a backslash; it is not a separator here.
  expect(directoryStrings("/opt/a\\b/prog")).toEqual([
    "/opt/a\\b/.debug/prog.debug",
    "/usr/lib/debug/opt/a\\b/prog.debug",
  ]);
});

it("uses the directory of a Windows image path with a drive letter", () => {
  expect(directoryStrings("C:\\dir\\sub\\prog")).toEqual([
    "C:\\dir\\sub\\.debug\\prog.debug",
    "/usr/lib/debug/C/dir/sub/prog.debug",
  ]);
  expect(directoryStrings("C:\\prog")).toEqual([
    "C:\\.debug\\prog.debug",
    "/usr/lib/debug/C/prog.debug",
  ]);
  expect(directoryStrings("D:/mixed\\dir/prog")).toEqual([
    "D:/mixed\\dir\\.debug\\prog.debug",
    "/usr/lib/debug/D/mixed/dir/prog.debug",
  ]);
  expect(directoryStrings("\\\\server\\share\\prog")).toEqual([
    "\\\\server\\share\\.debug\\prog.debug",
    "/usr/lib/debug/server/share/prog.debug",
  ]);
});

it("omits directory strings for a name that is not one segment", () => {
  const paths = deriveDebugFileLookupPaths({
    binaryPath: "/opt/prog",
    debuglinkName: "dir/prog.debug",
    buildIdHex: "ab",
    altBuildIdHex: null,
  });
  expect(paths.map((entry) => entry.kind)).toEqual(["build_id"]);
  expect(paths[0]?.path).toBe("/usr/lib/debug/.build-id/ab/.debug");
});

it("omits a build-id path when the hex length is odd", () => {
  expect(
    deriveDebugFileLookupPaths({
      binaryPath: "/prog",
      debuglinkName: "..",
      buildIdHex: "abc",
      altBuildIdHex: null,
    }),
  ).toEqual([]);
});

it("accepts an explicit absence report", () => {
  const parsed = elfDebugLinkSchema.parse({
    artifact: { path: "/artifacts/prog", sha256: digest, bytes: 64 },
    format: "elf64",
    byte_order: "little",
    machine: 62,
    type: 3,
    type_name: "shared",
    debuglink: {
      status: "absent",
      location: null,
      filename: null,
      crc32_hex: null,
      reason: null,
    },
    debugaltlink: {
      status: "absent",
      location: null,
      filename: null,
      build_id_hex: null,
      reason: null,
    },
    debugdata: {
      status: "absent",
      location: null,
      xz_magic: null,
      reason: null,
    },
    build_id: {
      status: "absent",
      hex: null,
      ids: [],
      sources: [],
      reason: null,
    },
    lookup_paths: [],
    candidate: null,
    verification: null,
    coverage: { status: "complete", examined_sections: 0 },
    limitations: [...ELF_DEBUG_LINK_LIMITATIONS],
  });
  expect(parsed.coverage.status).toBe("complete");
});
