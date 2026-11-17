import { registerCliCommand } from "../../../src/cli/commandRegistry.js";
import { createCommandCli } from "../../support/cli/commandCli.js";
import { EVIDENCE_FORMAT_REVISION } from "../../../src/domain/evidenceFormat.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import { explicitSensitiveValueOptions } from "../../../src/cli/explicitSensitiveArguments.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

type CliInstance = ReturnType<typeof createCommandCli>;
const serve = async (cli: CliInstance, argv: string[]) => {
  let stdout = "";
  let exitCode = 0;
  await cli.serve([...argv, "--json"], {
    env: {},
    stdout: (text) => {
      stdout += text;
    },
    exit: (code) => {
      exitCode = code;
    },
  });
  return { stdout, exitCode };
};

it("rejects surplus public CLI inputs before importing and retains the one-path control", async () => {
  const directory = await createTestTempDirectory(
    "rea-strict-cli-positionals-",
  );
  const path = join(directory, "bundle.json");
  await writeFile(
    path,
    JSON.stringify({
      evidence_format: EVIDENCE_FORMAT_REVISION,
      artifacts: [],
      captures: [],
      environments: [],
      providers: [],
      records: [],
      scenarios: [],
      unknowns: [],
    }),
  );
  const cli = createCli({});
  for (const extra of [["ignored"], ["ignored", "second"]]) {
    const result = await serve(cli, ["evidence-import", path, ...extra]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Unexpected positional arguments");
    for (const value of extra) expect(result.stdout).toContain(value);
  }
  const missingFile = await serve(cli, [
    "evidence-import",
    join(directory, "absent"),
    "extra",
  ]);
  expect(missingFile.exitCode).toBe(1);
  expect(missingFile.stdout).toContain("Unexpected positional arguments");
  const valid = await serve(cli, ["evidence-import", path]);
  expect(valid.exitCode).toBe(0);
  expect(JSON.parse(valid.stdout)).toMatchObject({ imported: 0, total: 0 });
  expect((await serve(cli, ["providers", "ignored"])).exitCode).toBe(1);
  const unknown = await serve(cli, ["providers", "--bogus"]);
  expect(unknown.exitCode).toBe(1);
  expect(unknown.stdout).toContain("Unknown flag: --bogus");
});

it("keeps parser-owned aliases, option values and optional arguments without rerunning transforms", async () => {
  let runs = 0;
  let transforms = 0;
  let defaults = 0;
  const cli = createCommandCli();
  registerCliCommand(cli, "scalar", {
    args: z.object({
      first: z.string().transform((value) => {
        transforms++;
        return value;
      }),
      second: z.string().optional(),
    }),
    options: z.object({
      selectedValue: z.string(),
      enabled: z.boolean().default(false),
      tag: z.array(z.string()).default([]),
      supplied: z.string().default(() => {
        defaults++;
        return "default";
      }),
      ...explicitSensitiveValueOptions,
    }),
    alias: { selectedValue: "s", enabled: "e" },
    run: ({ args, options }) => {
      runs++;
      return { args, options };
    },
  });
  const valid = await serve(cli, [
    "scalar",
    "one",
    "-es",
    "option value",
    "--tag=a",
    "--tag",
    "b",
  ]);
  expect(valid.exitCode).toBe(0);
  expect(JSON.parse(valid.stdout)).toMatchObject({
    args: { first: "one" },
    options: { enabled: true, selectedValue: "option value", tag: ["a", "b"] },
  });
  expect({ runs, transforms, defaults }).toEqual({
    runs: 1,
    transforms: 1,
    defaults: 1,
  });
  const invalid = await serve(cli, [
    "scalar",
    "one",
    "two",
    "sensitive-extra",
    "-s",
    "value",
    "--sensitive-value",
    "sensitive-extra",
  ]);
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stdout).toContain("Unexpected positional arguments");
  expect(invalid.stdout).not.toContain("sensitive-extra");
  expect({ runs, transforms, defaults }).toEqual({
    runs: 1,
    transforms: 1,
    defaults: 1,
  });
  expect(
    (await serve(cli, ["scalar", "one", "two", "-s", "value"])).exitCode,
  ).toBe(0);
});

it("enforces a scalar's arity and preserves declared variadic inputs", async () => {
  const cli = createCommandCli();
  registerCliCommand(cli, "scalar", {
    args: z.object({ value: z.string() }),
    run: ({ args }) => args,
  });
  registerCliCommand(cli, "many", {
    args: z.object({ values: z.array(z.string()) }),
    run: ({ args }) => args,
  });
  expect((await serve(cli, ["scalar", "one"])).exitCode).toBe(0);
  expect((await serve(cli, ["scalar", "one", "extra"])).exitCode).toBe(1);
  const many = await serve(cli, ["many", "one", "two", "three"]);
  expect(many.exitCode).toBe(0);
  expect(JSON.parse(many.stdout)).toMatchObject({
    values: ["one", "two", "three"],
  });
});

it("preserves counted aliases and negated booleans while checking the positional tail", async () => {
  let runs = 0;
  const cli = createCommandCli();
  registerCliCommand(cli, "capture", {
    args: z.object({ path: z.string() }),
    options: z.object({
      enabled: z.boolean().default(true),
      verbosity: z.number().default(0).meta({ count: true }),
    }),
    alias: { verbosity: "v" },
    run: ({ args, options }) => {
      runs++;
      return { args, options };
    },
  });
  const valid = await serve(cli, ["capture", "one", "--no-enabled", "-vvv"]);
  expect(valid.exitCode).toBe(0);
  expect(JSON.parse(valid.stdout)).toMatchObject({
    args: { path: "one" },
    options: { enabled: false, verbosity: 3 },
  });
  const surplus = await serve(cli, [
    "capture",
    "one",
    "--no-enabled",
    "-vvv",
    "extra",
  ]);
  expect(surplus.exitCode).toBe(1);
  expect(surplus.stdout).toContain("Unexpected positional arguments");
  expect(runs).toBe(1);
});

it("validates every dry-run literal before lossy coercion while retaining bare and negated controls", async () => {
  let runs = 0;
  let defaults = 0;
  const cli = createCommandCli();
  registerCliCommand(cli, "setup", {
    options: z.object({
      dryRun: z.boolean().default(false),
      selected: z.string().default(() => {
        defaults++;
        return "default";
      }),
    }),
    run: ({ options }) => {
      runs++;
      return options;
    },
  });
  for (const literal of ["", "abc", "1", "True", "ab\ncd"]) {
    const result = await serve(cli, [
      "setup",
      `--dry-run=${literal}`,
      "--dryRun=false",
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: "PARSE_ERROR" });
  }
  expect({ runs, defaults }).toEqual({ runs: 0, defaults: 0 });
  for (const [tokens, expected] of [
    [["--dry-run"], true],
    [["--dryRun=true"], true],
    [["--dry-run=false"], false],
    [["--no-dry-run"], false],
    [["--no-dryRun", "--dry-run"], true],
  ] as const) {
    const result = await serve(cli, ["setup", ...tokens]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: expected });
  }
  expect({ runs, defaults }).toEqual({ runs: 5, defaults: 5 });
});

it("keeps flag-shaped option data untouched while validating only bound dry-run values", async () => {
  const cli = createCommandCli();
  registerCliCommand(cli, "setup", {
    options: z.object({
      dryRun: z.boolean().default(false),
      selected: z.string(),
    }),
    alias: { selected: "s" },
    run: ({ options }) => options,
  });
  registerCliCommand(cli, "text", {
    options: z.object({ dryRun: z.string() }),
    run: ({ options }) => options,
  });
  for (const value of ["--dry-run=abc", "--dry-run", "--no-dryRun"]) {
    const result = await serve(cli, ["setup", "-s", value, "--dry-run=true"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      selected: value,
    });
  }
  const text = await serve(cli, ["text", "--dry-run=abc"]);
  expect(text.exitCode).toBe(0);
  expect(JSON.parse(text.stdout)).toEqual({ dryRun: "abc" });
});

it("validates dry-run on variadic commands without losing their declared tail", async () => {
  let runs = 0;
  const cli = createCommandCli();
  registerCliCommand(cli, "many", {
    args: z.object({
      values: z.array(z.string()),
    }),
    options: z.object({ dryRun: z.boolean().default(false) }),
    run: ({ args, options }) => {
      runs++;
      return { args, options };
    },
  });
  const rejected = await serve(cli, ["many", "one", "two", "--dry-run=abc"]);
  expect(rejected.exitCode).toBe(1);
  expect(runs).toBe(0);
  const accepted = await serve(cli, ["many", "one", "two", "--no-dry-run"]);
  expect(accepted.exitCode, accepted.stdout).toBe(0);
  expect(JSON.parse(accepted.stdout)).toMatchObject({
    args: { values: ["one", "two"] },
    options: { dryRun: false },
  });
  expect(runs).toBe(1);
});
