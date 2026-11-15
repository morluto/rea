import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import { augmentCliGlobalHelp } from "../../../src/cli/cliGlobalHelp.js";

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

const listsJsonOption = (help: string): boolean =>
  /^ {2}--json(?:\s|$)/mu.test(help);

describe("augmentCliGlobalHelp", () => {
  it("inserts --json alphabetically into a Global Options section", () => {
    const help = [
      "Usage: rea",
      "Global Options:",
      "  --format <toon|json|yaml|md|jsonl>  Output format",
      "  --help                              Show help",
      "",
    ].join("\n");
    const augmented = augmentCliGlobalHelp(help);
    expect(listsJsonOption(augmented)).toBe(true);
    const lines = augmented.split("\n");
    const format = lines.indexOf(
      "  --format <toon|json|yaml|md|jsonl>  Output format",
    );
    const helpLine = lines.indexOf(
      "  --help                              Show help",
    );
    const json = lines.findIndex((line) => /^ {2}--json(?:\s|$)/u.test(line));
    expect(json).toBeGreaterThan(format);
    expect(json).toBeGreaterThan(helpLine);
  });

  it("leaves help unchanged when --json is already listed", () => {
    const help = [
      "Global Options:",
      "  --json                              Shorthand for --format json",
      "  --help                              Show help",
    ].join("\n");
    expect(augmentCliGlobalHelp(help)).toBe(help);
  });

  it("leaves pages without Global Options unchanged", () => {
    const help = "Usage: rea mcp doctor\nOptions:\n  --help\n";
    expect(augmentCliGlobalHelp(help)).toBe(help);
  });
});

describe("CLI global --json help", () => {
  it.each([["--help"], ["capabilities", "--help"]] as const)(
    "lists --json for %j",
    async (...argv) => {
      const { stdout, exitCode } = await serve(createCli({}), argv);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Global Options:");
      expect(listsJsonOption(stdout)).toBe(true);
    },
  );
});
