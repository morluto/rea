import { expect, it } from "vitest";

import { serveCli } from "./cliServeHarness.js";

const jebEnvironment = {
  REA_JEB_MCP_URL: "http://127.0.0.1:1/mcp",
};

const serve = async (
  argv: readonly string[],
): Promise<{ readonly stdout: string; readonly exitCode: number }> =>
  serveCli(argv, jebEnvironment);

it("reports an unreachable engine endpoint with recovery guidance", async () => {
  const result = await serve(["inspect-jeb-client", "--json"]);
  expect(result.stdout).toContain("capability_unavailable");
  expect(result.stdout).toContain("REA_JEB_MCP_URL");
});

it("validates decompile item input before contacting the engine", async () => {
  const result = await serve(["decompile-jeb-item", "", "method", "--json"]);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    code: "VALIDATION_ERROR",
    fieldErrors: [
      {
        code: "too_small",
        path: "item-address",
      },
    ],
  });
});

it("reports an invalid endpoint without breaking other commands", async () => {
  const environment = { REA_JEB_MCP_URL: "http://localhost:8425/mcp" };
  const jeb = await serveCli(["inspect-jeb-client", "--json"], environment);
  expect(JSON.parse(jeb.stdout)).toMatchObject({
    code: "configuration_invalid",
    details: { settings: [{ setting: "REA_JEB_MCP_URL" }] },
  });
  const capabilities = await serveCli(["capabilities", "--json"], environment);
  expect(capabilities.exitCode).toBe(0);
});
