import { describe, expect, it } from "vitest";
import { resolveUvPythonPath } from "./SetupPythonEnvironment.js";

describe("SetupPythonEnvironment", () => {
  it("preserves explicit absolute REA_PWNTOOLS_PYTHON", () => {
    const custom =
      process.platform === "win32"
        ? "C:\\Python312\\python.exe"
        : "/opt/custom/bin/python";
    expect(resolveUvPythonPath({ REA_PWNTOOLS_PYTHON: custom })).toBe(custom);
  });

  it("returns undefined when uv is not in PATH or fallbacks", () => {
    expect(
      resolveUvPythonPath({
        PATH: "",
        Path: "",
        USERPROFILE: "C:\\NonExistentDirectory",
        HOME: "/nonexistent",
        APPDATA: "C:\\NonExistentDirectory",
      }),
    ).toBeUndefined();
  });
});
