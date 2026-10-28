import { resolve } from "node:path";
import { Cli, z } from "incur";
import { expect, it } from "vitest";

import { createCliCompletions } from "../../../src/cli/completions.js";
import { workspaceCliTest } from "../../support/cli/workspaceCliFixture.js";

const registry = () =>
  Cli.create("rea", { sync: false }).command("instructions", {
    options: z.object({
      procedure: z.string().optional(),
      targetFormat: z.enum(["dos-com", "raw-binary"]).optional(),
    }),
    run: () => {
      throw new Error("Completion must not execute a command");
    },
  });
const complete = (words: string[], index = words.length - 1) => {
  let text = "";
  const callback = createCliCompletions(registry(), {
    COMPLETE: "bash",
    _COMPLETE_INDEX: String(index),
  });
  expect(
    callback(["--", ...words], {
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
  expect(complete(["rea", "mcp", ""])).toEqual(["add", "doctor"]);
  expect(complete(["rea", "mcp", "d"])).toEqual(["doctor"]);
  expect(complete(["rea", "mcp", "ad"])).toEqual(["add"]);
  expect(complete(["rea", "mcp"], 2)).toEqual(["add", "doctor"]);
  expect(complete(["rea", ""])).toEqual(["instructions", "mcp", "completions"]);
  expect(complete(["rea", "completions", "b"])).toEqual(["bash"]);
  expect(complete(["rea", "mcp", "add", "--c"])).toEqual([
    "--command",
    "--columns",
  ]);
});

it("uses canonical global flag metadata and retains command options and enum hints", () => {
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
  expect(complete(["rea", "instructions", "--format", ""])).toEqual([
    "toon",
    "json",
    "yaml",
    "md",
    "jsonl",
    "csv",
    "tsv",
  ]);
  expect(complete(["rea", "mcp", "doctor", "--format", ""])).toEqual([
    "toon",
    "json",
    "yaml",
    "md",
    "jsonl",
  ]);
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

it("shares Bash registration across ordinary and protocol routes while retaining builtin precedence", () => {
  const cli = registry();
  let direct = "";
  const ordinary = createCliCompletions(cli, {});
  expect(
    ordinary(["--format", "json", "completions", "bash"], {
      stdout: (text) => {
        direct += text;
      },
    }),
  ).toBe(true);
  let protocol = "";
  expect(
    createCliCompletions(cli, { COMPLETE: "bash" })([], {
      stdout: (text) => {
        protocol += text;
      },
    }),
  ).toBe(true);
  expect(direct.trim()).toBe(protocol.trim());
  expect(direct).toContain("type compopt");
  expect(direct).toContain("||\n    complete -o default -o bashdefault");
  expect(ordinary(["completions", "bash", "--help"], {})).toBe(false);
  expect(ordinary(["completions", "bash", "--schema"], {})).toBe(false);
});

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
  },
);
