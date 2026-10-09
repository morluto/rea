import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";

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

// #1186: both xrefs selectors advertised "Address or symbol name", but the
// operation takes an analyzed address and its schema rejects a name — the
// reported workflow failed on the spelling its own help invited. The name
// workflow is find_xrefs_to_name (list_names + xrefs) over MCP, or resolving
// the address first on the CLI.
describe("xrefs selector help", () => {
  it("advertises an analyzed address, not a symbol name", async () => {
    const cli = createCli({});

    const help = await serve(cli, ["xrefs", "--help"]);

    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Analyzed code or data address");
    expect(help.stdout).not.toContain("symbol name");
  });

  it("keeps the equals form for values with leading dashes", async () => {
    const cli = createCli({});

    const help = await serve(cli, ["xrefs", "--help"]);

    expect(help.stdout).toContain("--address=<value>");
  });
});
