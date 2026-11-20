import { createCommandCli } from "../../support/cli/commandCli.js";
import { resolve } from "node:path";
import { z } from "zod";
import { expect, it } from "vitest";

import { registerCliCommand } from "../../../src/cli/commandRegistry.js";
import { createCliShell } from "../../../src/cli/cliShell.js";
import { createCliCompletions } from "../../../src/cli/completions.js";
import { workspaceCliTest } from "../../support/cli/workspaceCliFixture.js";
import { serveInProcessCli } from "../../support/cli/serveInProcessCli.js";

const registry = () => {
  const cli = createCommandCli();
  registerCliCommand(cli, "instructions", {
    options: z.object({
      procedure: z.string().optional(),
      targetFormat: z.enum(["dos-com", "raw-binary"]).optional(),
    }),
    run: () => {
      throw new Error("Completion must not execute a command");
    },
  });
  return cli;
};
const complete = (words: string[], index = words.length - 1) => {
  let text = "";
  const callback = createCliCompletions(registry(), {
    COMPLETE: "bash",
    _COMPLETE_INDEX: String(index),
  });
  expect(
    callback.complete(["--", ...words], {
      stdout: (value) => {
        text += value;
      },
    }),
  ).toBe(true);
  return text === ""
    ? []
    : text
        .split("\v")
        .map((value) => (value.endsWith("\x01") ? value.slice(0, -1) : value));
};

it("resolves enabled builtin scopes in the same tree as registered commands", () => {
  expect(complete(["rea", "mcp", "d"])).toEqual(["doctor"]);
  expect(complete(["rea", "mcp"], 2)).toEqual(["add", "doctor"]);
  expect(complete(["rea", ""])).toEqual(["instructions", "mcp", "completions"]);
  expect(complete(["rea", "completions", "b"])).toEqual(["bash"]);
  expect(complete(["rea", "mcp", "add", "--c"])).toEqual([
    "--command",
    "--columns",
  ]);
});

it("uses canonical global flag metadata and retains command options and enum hints", () => {
  expect(complete(["rea", "instructions", "--", "--he"])).toEqual([]);
  expect(complete(["rea", "instructions", "--he"])).toEqual(["--help"]);
  expect(complete(["rea", "instructions", "--for"])).toEqual(["--format"]);
  expect(complete(["rea", "instructions", "--tok"])).toEqual(
    expect.arrayContaining([
      "--token-count",
      "--token-limit",
      "--token-offset",
    ]),
  );
  expect(complete(["rea", "instructions", "--proc"])).toEqual(["--procedure"]);
  expect(complete(["rea", "instructions", "--target-format", ""])).toEqual([
    "dos-com",
    "raw-binary",
  ]);
  expect(complete(["rea", "mcp", "doctor", "--format", ""])).toEqual([
    "toon",
    "json",
    "yaml",
    "md",
    "jsonl",
  ]);
  expect(complete(["rea", "mcp", "doctor", "--t"])).toEqual(["--timings"]);
  expect(complete(["rea", "mcp", "doctor", "-h"])).toEqual(["-h"]);
  expect(complete(["rea", "--filter-output", "mcp", ""])).toEqual([
    "instructions",
    "mcp",
    "completions",
  ]);
  expect(complete(["rea", "instructions", "--"])).not.toContain(
    "--incur-update-check",
  );
  expect(complete(["rea", "instructions", "--"])).not.toContain("--mcp");
});

it("serves the Bash script through both public generation routes", async () => {
  const ordinary = await serveInProcessCli(createCommandCli(), [
    "completions",
    "bash",
  ]);
  const protocol = await serveInProcessCli(
    createCliShell({
      selectedEnvironment: { COMPLETE: "bash" },
      registrations: [],
    }),
    [],
  );
  expect(ordinary.exitCode).toBe(0);
  expect(ordinary.stdout).toContain('export COMPLETE="bash"');
  expect(protocol.exitCode).toBe(0);
  expect(protocol.stdout.trimEnd()).toBe(ordinary.stdout.trimEnd());

  const help = await serveInProcessCli(createCommandCli(), [
    "completions",
    "bash",
    "--help",
  ]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("Usage: rea completions");
  expect(help.stdout).not.toContain('export COMPLETE="bash"');
});

it("refuses a second shell", async () => {
  const reply = await serveInProcessCli(createCommandCli(), [
    "completions",
    "bash",
    "fish",
  ]);
  expect(reply.exitCode).toBe(1);
  expect(reply.stdout).toContain("completions expects exactly one shell");
});

workspaceCliTest(
  "explains zsh completion initialization in public help",
  async ({ processes, workspace }) => {
    const environment = {
      ...process.env,
      ...workspace.environment,
      REA_LOG_LEVEL: "silent",
      REA_TEST_NODE: process.execPath,
      REA_TEST_DISPATCHER: resolve("scripts/rea.mjs"),
    };
    for (const arguments_ of [["completions", "--help"], ["completions"]]) {
      const help = await processes.run(
        process.execPath,
        [resolve("scripts/rea.mjs"), ...arguments_],
        { env: environment },
      );
      expect(help.exitCode, help.stderr).toBe(0);
      expect(help.stdout).toContain(
        "initialize completion with `autoload -Uz compinit; compinit` before evaluating the zsh hook",
      );
    }
  },
);

workspaceCliTest.skipIf(process.platform !== "darwin")(
  "registers zsh completion after compinit",
  async ({ processes, workspace }) => {
    const environment = {
      ...process.env,
      ...workspace.environment,
      REA_LOG_LEVEL: "silent",
      REA_TEST_NODE: process.execPath,
      REA_TEST_DISPATCHER: resolve("scripts/rea.mjs"),
    };
    const result = await processes.run(
      "zsh",
      [
        "-f",
        "-c",
        `
rea() { "$REA_TEST_NODE" "$REA_TEST_DISPATCHER" "$@"; }
autoload -Uz compinit
compinit -i -D
eval "$(rea completions zsh)" || exit
print -r -- "association=\${+_comps[rea]}"
`,
      ],
      { env: environment },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("association=1\n");
  },
);

workspaceCliTest.skipIf(process.platform === "win32")(
  "runs generated Bash completion with valid MCP scope and incomplete global values through the public launcher",
  async ({ processes, workspace }) => {
    const result = await processes.run(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `
rea() { "$REA_TEST_NODE" "$REA_TEST_DISPATCHER" "$@"; }
eval "$(rea completions bash)" || exit
COMP_WORDS=(rea mcp "")
COMP_CWORD=2
_incur_complete_rea || exit
printf 'mcp=%s\\n' "\${COMPREPLY[*]}"
COMP_WORDS=(rea instructions --format "")
COMP_CWORD=3
_incur_complete_rea || exit
printf 'format=%s\\n' "\${COMPREPLY[*]}"
COMP_WORDS=(rea mcp doctor --)
COMP_CWORD=3
_incur_complete_rea || exit
printf 'doctor=%s\\n' "\${COMPREPLY[*]}"
`,
      ],
      {
        env: {
          ...process.env,
          ...workspace.environment,
          REA_LOG_LEVEL: "silent",
          REA_TEST_NODE: process.execPath,
          REA_TEST_DISPATCHER: resolve("scripts/rea.mjs"),
        },
      },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("mcp=add doctor\n");
    expect(result.stdout).toContain("format=toon json yaml md jsonl csv tsv\n");
    expect(result.stdout).toContain(
      "doctor=--format --json --full-output --help --timings\n",
    );
  },
);
