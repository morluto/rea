import { expect } from "vitest";

import {
  cliProcessEnvironment,
  cliTest,
  definedCliEnvironment,
} from "../../support/cli/cliFixture.js";

// The file session and the executable run one shared one-shot owner. Compare
// a fresh process with the session itself: `cli.run` may route either way.
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
  {
    // The session's own stdin carries its frames; a command that reads
    // stdin must see the same empty input a fresh process does.
    name: "a command reading absent stdin",
    arguments: ["compare-wasm-interfaces", "-", "--json"],
  },
])(
  "the file session reports $name exactly as a fresh process does",
  async ({ arguments: arguments_ }, { cli, cliCommandSession }) => {
    const environment = { REA_LOG_LEVEL: "silent" };
    const fresh = await cli.run({
      arguments: arguments_,
      environment,
      freshProcess: true,
    });
    const shared = await cliCommandSession.run({
      arguments: arguments_,
      cwd: process.cwd(),
      environment: definedCliEnvironment(cliProcessEnvironment(environment)),
    });
    expect(fresh.stdout + fresh.stderr).not.toBe("");
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
