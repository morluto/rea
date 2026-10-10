import { describe, expect, it } from "vitest";

import {
  APKTOOL_COMMAND_ENV,
  parseApktoolVersionOutput,
  resolveApktoolCommand,
} from "./ApktoolConfiguration.js";

describe("resolveApktoolCommand", () => {
  it("prefers an absolute REA_APKTOOL_COMMAND", () => {
    expect(
      resolveApktoolCommand({
        [APKTOOL_COMMAND_ENV]: "/usr/local/bin/apktool",
      }),
    ).toEqual({
      command: "/usr/local/bin/apktool",
      commandSource: "environment",
    });
  });

  it("falls back to PATH resolution without the environment key", () => {
    expect(resolveApktoolCommand({})).toEqual({
      command: "apktool",
      commandSource: "path",
    });
  });

  it("rejects a relative environment path explicitly", () => {
    expect(() =>
      resolveApktoolCommand({ [APKTOOL_COMMAND_ENV]: "bin/apktool" }),
    ).toThrow(/must be an absolute path/u);
  });
});

describe("parseApktoolVersionOutput", () => {
  it("reads the version from real apktool output", () => {
    expect(parseApktoolVersionOutput("2.7.0-dirty\n")).toEqual({
      version: "2.7.0-dirty",
    });
  });

  it("reports null when the launcher prints nothing usable", () => {
    expect(parseApktoolVersionOutput(" \n")).toEqual({ version: null });
  });
});
