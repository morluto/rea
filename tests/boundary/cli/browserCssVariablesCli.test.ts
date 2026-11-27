import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import { BROWSER_TOOL_CONTRACTS } from "../../../src/contracts/browserToolContracts.js";

type CliInstance = ReturnType<typeof createCli>;

const serve = async (
  cli: CliInstance,
  argv: readonly string[],
): Promise<{ readonly stdout: string; readonly exitCode: number }> => {
  let stdout = "";
  let exitCode = 0;
  await cli.serve([...argv], {
    env: {},
    exit: (code) => {
      exitCode = code;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  return { stdout, exitCode };
};

describe("browser CSS variables CLI and MCP exposure", () => {
  it("advertises --include-css-variables in inspect-web-page CLI help", async () => {
    const cli = createCli({});
    const help = await serve(cli, ["inspect-web-page", "--help"]);
    expect(help.stdout).toContain("--include-css-variables");
    expect(help.stdout).toMatch(
      /--include-css-variables\s+Include root CSS custom properties and variables/u,
    );
  });

  it("exposes CSS variables contracts in the inspect_web_page MCP tool", () => {
    const contract = BROWSER_TOOL_CONTRACTS.find(
      (c) => c.name === "inspect_web_page",
    );
    expect(contract).toBeDefined();
    expect(contract?.description).toContain("root CSS variables");
    expect(contract?.examples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Inspect page styles and design tokens",
          input: expect.objectContaining({
            include_css_variables: true,
          }),
        }),
      ]),
    );
  });
});
