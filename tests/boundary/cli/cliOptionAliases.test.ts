import { cliCommand, cliCommands } from "../../../src/cli/commandRegistry.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createCli } from "../../../src/cli.js";
import {
  cliCommandOptionNames,
  createCliInventory,
} from "../../../scripts/lib/catalog-cli.mjs";

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

const registeredAliases = (
  cli: CliInstance,
  command: string,
): Record<string, unknown> => {
  const entry = cliCommand(cli, command)?.definition;
  const alias: unknown =
    entry === undefined ? undefined : Reflect.get(entry, "alias");
  return typeof alias === "object" && alias !== null ? { ...alias } : {};
};

describe("CLI option aliases", () => {
  it("rejects an empty primary command inventory", () => {
    expect(() => createCliInventory([])).toThrow(
      "REA exposed no primary CLI commands",
    );
  });

  it("register only single-character short flags", async () => {
    const cli = createCli({});
    const invalid: string[] = [];
    const undescribed: string[] = [];
    for (const command of createCliInventory(cliCommands(cli)).primary) {
      for (const [option, short] of Object.entries(
        registeredAliases(cli, command),
      ))
        if (typeof short !== "string" || short.length !== 1)
          invalid.push(`${command} ${option}: ${String(short)}`);
      // Incur parses `-abc` as stacked one-letter flags, so help must never
      // advertise a multi-letter single-dash spelling.
      const help = await serve(cli, [command, "--help"]);
      expect(help.exitCode, `${command} --help`).toBe(0);
      expect(help.stdout, `${command} --help`).not.toBe("");
      for (const match of help.stdout.matchAll(/(?:^|[\s,])-([a-z][\w-]+)/gmu))
        invalid.push(`${command} help: -${match[1] ?? ""}`);
      const options = /^Options:\n((?: {2}.*\n?)*)/mu.exec(help.stdout)?.[1];
      const entry = cliCommand(cli, command)?.definition;
      expect(entry, `${command} registration`).toBeDefined();
      const schema: unknown = entry && Reflect.get(entry, "options");
      if (schema !== undefined)
        expect(schema, `${command} options schema`).toBeInstanceOf(z.ZodObject);
      if (cliCommandOptionNames(cliCommands(cli), command).length > 0) {
        expect(options, `${command} --help options`).toBeDefined();
        expect(options, `${command} --help option entries`).toMatch(/^  --/mu);
      }
      for (const line of options?.split("\n") ?? [])
        if (/^ {2}--\S+(?: <[^>]+>)?\s*$/u.test(line))
          undescribed.push(`${command} ${line.trim()}`);
    }
    expect(invalid).toEqual([]);
    expect(undescribed).toEqual([]);
  });

  it("accepts kebab-case long options without registered aliases", async () => {
    const cli = createCli({});
    const result = await serve(cli, [
      "inspect-plist",
      "/nonexistent/REA.app",
      "--relative-path",
      "Contents/Info.plist",
      "--json",
    ]);
    expect(result.stdout).not.toContain("Unknown flag");
    expect(result.stdout).toContain("/nonexistent/REA.app");
  });

  it("refuses the schema key spelling with the documented flag", async () => {
    // argvParser.test.ts covers each token shape (bare, inline value,
    // negation) against the structured flag_spelling failure; this case
    // checks the public CLI projection documented in getting-started/cli.md.
    const result = await serve(createCli({}), [
      "inspect-plist",
      "/nonexistent/REA.app",
      "--relativePath",
      "Contents/Info.plist",
      "--json",
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      code: "PARSE_ERROR",
      message: "Unknown flag: --relativePath. Did you mean --relative-path?",
      retryable: false,
    });
  });
});
