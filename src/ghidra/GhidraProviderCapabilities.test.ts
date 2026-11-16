import { describe, expect, it } from "vitest";

import { windowsP0Limitations } from "./GhidraProviderCapabilities.js";

describe("Windows Ghidra P0 filesystem boundary", () => {
  it("admits NTFS and ReFS targets and runtimes", () => {
    expect(windowsP0Limitations.join(" ")).toContain(
      "local NTFS/ReFS targets and runtimes",
    );
  });
});
