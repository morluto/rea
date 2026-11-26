import { expect, it } from "vitest";

import {
  MACOS_PKG_MAX_CPIO_ARCHIVE_BYTES,
  MACOS_PKG_MAX_CPIO_MEMBERS,
  MACOS_PKG_MAX_TOC_PATH_BYTES,
  hasXarMagic,
  macosPkgCpioBudget,
} from "./macosPkgFormat.js";

it("detects xar magic from a prefix", () => {
  expect(hasXarMagic(Buffer.from("xar!more"))).toBe(true);
  expect(hasXarMagic(Buffer.from("PK\u0003\u0004"))).toBe(false);
});

it("keeps default cpio allowances when expanded_bytes is omitted and scales them when raised", () => {
  expect(macosPkgCpioBudget(undefined)).toEqual({
    maxArchiveBytes: MACOS_PKG_MAX_CPIO_ARCHIVE_BYTES,
    maxMembers: MACOS_PKG_MAX_CPIO_MEMBERS,
    maxPathBytes: MACOS_PKG_MAX_TOC_PATH_BYTES,
    callerControlled: false,
  });

  expect(macosPkgCpioBudget(128 * 1024 * 1024)).toEqual({
    maxArchiveBytes: 128 * 1024 * 1024,
    maxMembers: 8192,
    maxPathBytes: 8 * 1024 * 1024,
    callerControlled: true,
  });

  expect(macosPkgCpioBudget(96 * 1024)).toEqual({
    maxArchiveBytes: 96 * 1024,
    maxMembers: MACOS_PKG_MAX_CPIO_MEMBERS,
    maxPathBytes: MACOS_PKG_MAX_TOC_PATH_BYTES,
    callerControlled: true,
  });
});
