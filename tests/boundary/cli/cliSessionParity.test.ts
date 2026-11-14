import { expect } from "vitest";

import { cliTest, runFileCli } from "../../support/cli/cliFixture.js";

// The file session and the executable run one shared one-shot owner. These
// commands are answered before the command runtime loads, which is where a
// separate session implementation previously diverged.
cliTest.for([
  { name: "a formatted version report", arguments: ["--version", "--json"] },
  {
    name: "a project-scoped Amp registration refusal",
    arguments: ["mcp", "add", "--no-global", "--agent", "amp", "--json"],
  },
  {
    name: "a rejected output combination",
    arguments: ["capabilities", "--json", "--token-limit", "5"],
  },
])(
  "the file session reports $name exactly as a fresh process does",
  async ({ arguments: arguments_ }, { cli }) => {
    const environment = { REA_LOG_LEVEL: "silent" };
    const fresh = await cli.run({ arguments: arguments_, environment });
    const shared = await runFileCli(cli, {
      arguments: arguments_,
      environment,
    });
    expect(fresh.stdout).not.toBe("");
    expect({
      exitCode: shared.exitCode,
      stdout: shared.stdout,
      stderr: shared.stderr,
    }).toEqual({
      exitCode: fresh.exitCode,
      stdout: fresh.stdout,
      stderr: fresh.stderr,
    });
  },
);
