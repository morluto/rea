import { describe, expect, it } from "vitest";

import { defaultGhidraTransport } from "./GhidraTransport.js";

describe("defaultGhidraTransport", () => {
  it("selects authenticated loopback TCP on Windows", () => {
    expect(defaultGhidraTransport("win32")).toBe("authenticated-loopback-tcp");
  });

  it("selects a Unix socket on Linux and macOS", () => {
    expect(defaultGhidraTransport("linux")).toBe("unix-socket");
    expect(defaultGhidraTransport("darwin")).toBe("unix-socket");
  });
});
