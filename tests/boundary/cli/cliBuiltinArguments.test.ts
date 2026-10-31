import { describe, expect, it } from "vitest";

import {
  classifyMcpAddDiscovery,
  isProjectScopedAmpRegistration,
} from "../../../src/cliBuiltinArguments.js";

describe("mcp add discovery classification", () => {
  it("bypasses help and listing flags", () => {
    for (const flag of ["--help", "-h", "--llms", "--llms-full"]) {
      expect(classifyMcpAddDiscovery(new Set([flag]))).toBe("bypass");
    }
  });

  it("answers version and schema inside the mcp add special-casing", () => {
    expect(classifyMcpAddDiscovery(new Set(["--version"]))).toBe("version");
    expect(classifyMcpAddDiscovery(new Set(["--schema"]))).toBe("schema");
  });

  it("keeps routing precedence when several discovery flags combine", () => {
    expect(classifyMcpAddDiscovery(new Set(["--help", "--version"]))).toBe(
      "bypass",
    );
    expect(classifyMcpAddDiscovery(new Set(["--version", "--schema"]))).toBe(
      "version",
    );
  });

  it("returns undefined for real registrations", () => {
    expect(classifyMcpAddDiscovery(new Set(["--json"]))).toBeUndefined();
    expect(classifyMcpAddDiscovery(new Set())).toBeUndefined();
  });
});

describe("project-scoped Amp registration guard", () => {
  it("flags explicit Amp targets under --no-global", () => {
    expect(
      isProjectScopedAmpRegistration([
        "mcp",
        "add",
        "--no-global",
        "--agent",
        "amp",
        "--command",
        "node project-rea.mjs",
      ]),
    ).toBe(true);
  });

  it("flags the default Amp registration when no agent is given", () => {
    expect(isProjectScopedAmpRegistration(["mcp", "add", "--no-global"])).toBe(
      true,
    );
  });

  it("ignores output flags Incur strips before dispatch", () => {
    expect(
      isProjectScopedAmpRegistration([
        "mcp",
        "add",
        "--no-global",
        "--agent",
        "amp",
        "--command",
        "node project-rea.mjs",
        "--json",
      ]),
    ).toBe(true);
  });

  it("passes global Amp registration through", () => {
    expect(
      isProjectScopedAmpRegistration([
        "mcp",
        "add",
        "--agent",
        "amp",
        "--command",
        "node project-rea.mjs",
      ]),
    ).toBe(false);
  });

  it("passes project-scoped non-Amp agents through", () => {
    expect(
      isProjectScopedAmpRegistration([
        "mcp",
        "add",
        "--no-global",
        "--agent",
        "claude-code",
      ]),
    ).toBe(false);
  });

  it("passes discovery requests through, matching mcp add discovery", () => {
    for (const discovery of [
      "--help",
      "-h",
      "--llms",
      "--llms-full",
      "--version",
      "--schema",
    ]) {
      expect(
        isProjectScopedAmpRegistration([
          "mcp",
          "add",
          "--no-global",
          "--agent",
          "amp",
          discovery,
        ]),
      ).toBe(false);
    }
    expect(
      isProjectScopedAmpRegistration(["mcp", "add", "--no-global", "--help"]),
    ).toBe(false);
  });

  it("passes other commands through", () => {
    expect(isProjectScopedAmpRegistration(["mcp", "doctor"])).toBe(false);
    expect(isProjectScopedAmpRegistration(["doctor"])).toBe(false);
    expect(
      isProjectScopedAmpRegistration([
        "mcp",
        "add",
        "--no-global",
        "--agent",
        "Amp",
      ]),
    ).toBe(false);
  });
});
