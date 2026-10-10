import { describe, expect, it } from "vitest";

import {
  logicalPathEscapesRoot,
  logicalPathNfc,
  normalizeJoinedLogicalPath,
} from "./artifactIdentity.js";

describe("logical path identity", () => {
  it("joins NFD filenames to the NFC spelling inventory stores", () => {
    const nfd = "caf\u00e9".normalize("NFD");
    expect(nfd).not.toBe(logicalPathNfc(nfd));
    expect(normalizeJoinedLogicalPath(`dir/${nfd}.js`)).toBe(
      `dir/${"caf\u00e9".normalize("NFC")}.js`,
    );
    expect(
      logicalPathEscapesRoot(normalizeJoinedLogicalPath("../escape")),
    ).toBe(true);
    expect(normalizeJoinedLogicalPath(".")).toBe(".");
  });
});
