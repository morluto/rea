import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";

const serve = async (
  argv: readonly string[],
): Promise<{ readonly stdout: string; readonly exitCode: number }> => {
  let stdout = "";
  let exitCode = 0;
  await createCli().serve([...argv], {
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

const FORMAT_LINE = "--format <toon|json|yaml|md|jsonl|csv|tsv>";

const globalSection = (help: string): readonly string[] => {
  const lines = help.split("\n");
  const start = lines.findIndex((line) => line.trim() === "Global Options:");
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => !line.startsWith("  "));
  return end === -1 ? rest : rest.slice(0, end);
};

describe("global --format help", () => {
  it("advertises every accepted choice for a command", async () => {
    const result = await serve(["inspect-byte-entropy", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${FORMAT_LINE}  Output format`);
    expect(result.stdout).toContain(
      "CSV and TSV export requires --filter-output <row-array-path> and --columns <column,...>",
    );
  });

  it("advertises every accepted choice for root, group and builtin help", async () => {
    for (const arguments_ of [
      ["--help"],
      ["mcp", "--help"],
      ["mcp", "add", "--help"],
      ["mcp", "add", "-h"],
    ]) {
      const result = await serve(arguments_);
      expect(result.exitCode, arguments_.join(" ")).toBe(0);
      expect(result.stdout, arguments_.join(" ")).toContain(FORMAT_LINE);
    }
  });

  it("keeps every row in one description column", async () => {
    const result = await serve(["--help"]);
    const rows = globalSection(result.stdout);
    expect(rows.length).toBeGreaterThan(0);
    const descriptionStart = (row: string): number => {
      const match = /^ {2}(\S.*?) {2,}(\S.*)$/u.exec(row);
      return match === null ? -1 : row.indexOf(match[2]!, 2);
    };
    const columns = new Set(rows.map(descriptionStart));
    expect(columns.has(-1)).toBe(false);
    expect([...columns]).toHaveLength(1);
  });

  it("leaves manifests and help-free output alone", async () => {
    for (const arguments_ of [["--llms"], ["--llms-full"], ["--schema"]]) {
      const result = await serve(arguments_);
      expect(result.exitCode, arguments_.join(" ")).toBe(0);
      expect(result.stdout, arguments_.join(" ")).not.toContain(
        `${FORMAT_LINE}  Output format`,
      );
    }
  });

  it("keeps an explicit --format value while showing help", async () => {
    const result = await serve([
      "inspect-analysis-view",
      "--format",
      "csv",
      "--help",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(FORMAT_LINE);
  });

  it("shows help when a feature flag name is only an argument value", async () => {
    const result = await serve([
      "inspect-analysis-view",
      "--format",
      "csv",
      "--filter-output",
      "rows",
      "--columns",
      "--llms",
      "--help",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(FORMAT_LINE);
  });

  it("ends the help document with a terminated line", async () => {
    for (const arguments_ of [["--help"], ["mcp", "add", "--help"]]) {
      const result = await serve(arguments_);
      expect(result.exitCode, arguments_.join(" ")).toBe(0);
      expect(result.stdout.endsWith("\n"), arguments_.join(" ")).toBe(true);
      expect(
        result.stdout.includes("\n\nCSV and TSV export"),
        arguments_.join(" "),
      ).toBe(true);
    }
  });
});
