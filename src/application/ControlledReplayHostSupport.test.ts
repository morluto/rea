import { describe, expect, it } from "vitest";

import { isSupportedControlledReplayHost } from "./ControlledReplayHostSupport.js";

describe("controlled replay host support", () => {
  it("admits only Linux x86_64", () => {
    expect(isSupportedControlledReplayHost("linux", "x64")).toBe(true);
    expect(isSupportedControlledReplayHost("linux", "arm64")).toBe(false);
    expect(isSupportedControlledReplayHost("darwin", "x64")).toBe(false);
    expect(isSupportedControlledReplayHost("win32", "x64")).toBe(false);
  });
});
