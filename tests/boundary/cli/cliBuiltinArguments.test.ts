import { describe, expect, it } from "vitest";

import { isProjectScopedAmpRegistration } from "../../../src/cliBuiltinArguments.js";

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
