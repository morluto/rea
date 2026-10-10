import { expect, it } from "vitest";

import { serveCli } from "./cliServeHarness.js";

const jebEnvironment = {
  REA_JEB_MCP_URL: "http://127.0.0.1:1/mcp",
};

const serve = async (
  argv: readonly string[],
): Promise<{ readonly stdout: string; readonly exitCode: number }> =>
  serveCli(argv, jebEnvironment);

it.each([
  ["inspect-jeb-client"],
  ["open-jeb-project"],
  ["list-jeb-units"],
  ["decompile-jeb-item"],
])("%s advertises a schema through the public CLI", async (command) => {
  const result = await serve([command, "--schema", "--json"]);
  expect(result.exitCode, command).toBe(0);
  const schema = JSON.parse(result.stdout) as { args?: unknown };
  expect(schema).toBeTruthy();
});

it("reports an unreachable engine endpoint with recovery guidance", async () => {
  const result = await serve(["inspect-jeb-client", "--json"]);
  expect(result.stdout).toContain("capability_unavailable");
  expect(result.stdout).toContain("REA_JEB_MCP_URL");
});

it("validates decompile item input before contacting the engine", async () => {
  const result = await serve([
    "decompile-jeb-item",
    "not-an-address",
    "--item-kind",
    "method",
    "--json",
  ]);
  expect(result.stdout).toBeTruthy();
  expect(result.stdout).not.toContain("capability_unavailable");
});
