import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import { augmentCliHelpOutput } from "../../../src/cli/cliHelp.js";

describe("Global --json CLI help", () => {
  it("restores --json in Global Options immediately following --help", () => {
    const raw = [
      "rea capabilities — List provider capabilities",
      "",
      "Usage: rea capabilities",
      "",
      "Global Options:",
      "  --filter-output <keys>              Filter output by key paths",
      "  --format <toon|json|yaml|md|jsonl>  Output format",
      "  --full-output                       Show full output envelope",
      "  --help                              Show help",
      "  --llms, --llms-full                 Print LLM-readable manifest",
      "  --schema                            Show JSON Schema for command",
      "",
    ].join("\n");

    const augmented = augmentCliHelpOutput(raw);
    expect(augmented).toContain(
      "  --help                              Show help\n" +
        "  --json                              Select JSON output format; equivalent to --format json\n" +
        "  --llms, --llms-full                 Print LLM-readable manifest",
    );
  });

  it("preserves CRLF line endings when restoring --json", () => {
    const raw = [
      "Global Options:",
      "  --format <toon|json|yaml|md|jsonl>  Output format",
      "  --help                              Show help",
      "  --schema                            Show JSON Schema",
    ].join("\r\n");

    const augmented = augmentCliHelpOutput(raw);
    expect(augmented).toContain(
      "  --help                              Show help\r\n" +
        "  --json                              Select JSON output format; equivalent to --format json\r\n" +
        "  --schema                            Show JSON Schema",
    );
  });

  it("is idempotent when --json is already listed", () => {
    const input = [
      "Global Options:",
      "  --help  Show help",
      "  --json  Emit JSON",
    ].join("\n");
    expect(augmentCliHelpOutput(input)).toBe(input);
  });

  it("leaves non-help output without Global Options untouched", () => {
    const input = '{"status":"ok","count":42}\n';
    expect(augmentCliHelpOutput(input)).toBe(input);
  });

  it("advertises --json in ordinary command help via createCli", async () => {
    let stdout = "";
    const cli = createCli({});
    await cli.serve(["capabilities", "--help"], {
      stdout: (text) => {
        stdout += text;
      },
      exit: () => {},
    });

    expect(stdout).toMatch(/^ {2}--json(?:\s|$)/m);
    const globalSection = stdout.slice(stdout.indexOf("Global Options:"));
    const helpIndex = globalSection.indexOf("--help");
    const jsonIndex = globalSection.indexOf("--json");
    const llmsIndex = globalSection.indexOf("--llms");
    expect(helpIndex).toBeGreaterThan(-1);
    expect(jsonIndex).toBeGreaterThan(helpIndex);
    expect(llmsIndex).toBeGreaterThan(jsonIndex);
    expect(globalSection).toContain("--format <toon|json|yaml|md|jsonl>");
    expect(globalSection).toContain("equivalent to --format json");
  });

  it("advertises --json in root help via createCli", async () => {
    let stdout = "";
    const cli = createCli({});
    await cli.serve(["--help"], {
      stdout: (text) => {
        stdout += text;
      },
      exit: () => {},
    });

    expect(stdout).toMatch(/^ {2}--json(?:\s|$)/m);
    const globalSection = stdout.slice(stdout.indexOf("Global Options:"));
    const helpIndex = globalSection.indexOf("--help");
    const jsonIndex = globalSection.indexOf("--json");
    expect(helpIndex).toBeGreaterThan(-1);
    expect(jsonIndex).toBeGreaterThan(helpIndex);
  });
});
