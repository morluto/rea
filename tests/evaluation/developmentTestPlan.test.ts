import { describe, expect, it } from "vitest";

import {
  developmentTestPlan,
  parseDevelopmentTestRequest,
} from "../../scripts/lib/development-tests.mjs";

describe("development test selection", () => {
  it("keeps dirty source feedback independent of compiled artifacts", () => {
    const plan = developmentTestPlan(parseDevelopmentTestRequest("local", []));
    expect(plan.needsBuild).toBe(false);
    expect(plan.vitestArguments).toContain("--changed");
    expect(plan.vitestArguments).not.toContain("acceptance");
    expect(plan.vitestArguments).not.toContain("process-global");
  });

  it("always runs explicitly selected source tests, including on a clean tree", () => {
    const path = "src/config.test.ts";
    const plan = developmentTestPlan(
      parseDevelopmentTestRequest("local", [path, path]),
    );
    expect(plan.needsBuild).toBe(false);
    expect(
      plan.vitestArguments.filter((argument) => argument === path),
    ).toHaveLength(1);
    expect(
      plan.vitestArguments.some((argument) => argument.startsWith("--changed")),
    ).toBe(false);
    expect(plan.vitestArguments).not.toContain("--passWithNoTests");
  });

  it("builds before explicitly selected compiled boundaries", () => {
    const plan = developmentTestPlan(
      parseDevelopmentTestRequest("focused", [
        "src/config.test.ts",
        "tests/acceptance/applications/runtime.test.ts",
      ]),
    );
    expect(plan.needsBuild).toBe(true);
    expect(plan.vitestArguments).not.toContain("--changed");
  });

  it("uses the resolved branch merge base for committed source changes", () => {
    const request = parseDevelopmentTestRequest("changed", ["--base", "main"]);
    const plan = developmentTestPlan(request, "a".repeat(40));
    expect(request.base).toBe("main");
    expect(plan.vitestArguments).toContain(`--changed=${"a".repeat(40)}`);
    expect(() => developmentTestPlan(request)).toThrow(
      "resolved Git merge base",
    );
  });

  it.each([
    ["focused", []],
    ["focused", ["../src/config.test.ts"]],
    ["focused", ["src/../config.test.ts"]],
    ["focused", ["--passWithNoTests"]],
    ["focused", ["--changed"]],
    ["local", ["tests/acceptance/applications/runtime.test.ts"]],
    ["changed", ["--base"]],
    ["changed", ["--base=--help"]],
    ["changed", ["src/config.test.ts"]],
    ["local", ["--base", "main"]],
    ["unknown", []],
  ])("rejects invalid %s selections: %j", (mode, paths) => {
    expect(() => parseDevelopmentTestRequest(mode, paths)).toThrow();
  });
});
