import { z } from "zod";
import { describe, expect, it } from "vitest";

import { parseCliArgv } from "../../../src/cli/argvParser.js";
import { cliDecimalField } from "../../../src/cli/options.js";

const schemas = {
  args: z.object({ path: z.string(), rest: z.array(z.string()).optional() }),
  options: z.object({
    blockSize: z.number().default(4096),
    global: z.boolean().default(true),
    yes: z.boolean().optional(),
    column: z.array(z.string()).optional(),
    mode: z.enum(["a", "b"]).optional(),
  }),
  alias: { yes: "y", mode: "m" },
};

const bound = (
  argv: readonly string[],
  selected: Parameters<typeof parseCliArgv>[1] = schemas,
) => {
  const result = parseCliArgv(argv, selected);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const failure = (
  argv: readonly string[],
  selected: Parameters<typeof parseCliArgv>[1] = schemas,
) => {
  const result = parseCliArgv(argv, selected);
  if (result.ok) throw new Error("parse succeeded");
  return result.error;
};

describe("parseCliArgv", () => {
  it("binds kebab-case spellings, values and negations", () => {
    expect(
      bound([
        "file",
        "--block-size",
        "256",
        "--no-global",
        "--column=a",
        "--column",
        "b",
        "x",
        "y",
      ]),
    ).toEqual({
      args: { path: "file", rest: ["x", "y"] },
      options: { blockSize: 256, global: false, column: ["a", "b"] },
    });
    expect(bound(["file", "--block-size=512", "--global"]).options).toEqual({
      blockSize: 512,
      global: true,
    });
  });

  it("accepts only true and false as inline boolean values", () => {
    expect(bound(["file", "--yes=true", "--global=false"]).options).toEqual({
      blockSize: 4096,
      global: false,
      yes: true,
    });
    for (const literal of ["yes", "1", "TRUE", ""])
      expect(failure(["file", `--yes=${literal}`])).toMatchObject({
        kind: "validation",
        fieldErrors: [{ path: "yes", expected: "boolean" }],
      });
    expect(failure(["file", "--block-size="])).toMatchObject({
      kind: "validation",
      fieldErrors: [{ path: "blockSize", expected: "number" }],
    });
  });

  it("keeps a rejected boolean or number literal when a later occurrence is valid", () => {
    const rejectedBoolean = {
      kind: "validation",
      fieldErrors: [{ path: "yes", code: "invalid_type", expected: "boolean" }],
    };
    expect(failure(["file", "--yes=1", "--yes"])).toMatchObject(
      rejectedBoolean,
    );
    expect(failure(["file", "--yes=1", "--yes=true"])).toMatchObject(
      rejectedBoolean,
    );
    expect(failure(["file", "--yes=1", "-y"])).toMatchObject(rejectedBoolean);
    expect(failure(["file", "--global=no", "--no-global"])).toMatchObject({
      kind: "validation",
      fieldErrors: [
        { path: "global", code: "invalid_type", expected: "boolean" },
      ],
    });
    expect(
      failure(["file", "--block-size=abc", "--block-size=8"]),
    ).toMatchObject({
      kind: "validation",
      fieldErrors: [
        {
          path: "blockSize",
          code: "invalid_type",
          expected: "number",
          received: "NaN",
        },
      ],
    });
    expect(bound(["file", "--yes=false", "--yes"]).options.yes).toBe(true);
    expect(bound(["file", "--yes=true", "--yes=false"]).options.yes).toBe(
      false,
    );
    expect(
      bound(["file", "--block-size=8", "--block-size=16"]).options.blockSize,
    ).toBe(16);

    const counted = {
      options: z.object({
        verbosity: z.number().default(0).meta({ count: true }),
      }),
      alias: { verbosity: "v" },
    };
    expect(failure(["--verbosity=no", "-v"], counted)).toMatchObject({
      kind: "validation",
      fieldErrors: [
        { path: "verbosity", code: "invalid_type", expected: "number" },
      ],
    });
    expect(bound(["-vv"], counted).options).toEqual({ verbosity: 2 });

    const decimal = {
      options: z.object({
        limit: cliDecimalField(z.number().int().nonnegative().optional()),
      }),
    };
    expect(failure(["--limit=no", "--limit=4"], decimal)).toMatchObject({
      kind: "validation",
      fieldErrors: [{ path: "limit", code: "invalid_union" }],
    });
    expect(bound(["--limit=4", "--limit=8"], decimal).options).toEqual({
      limit: 8,
    });
  });

  it.each([
    [["file", "--blockSize", "512"], "--blockSize", "--block-size"],
    [["file", "--blockSize=512"], "--blockSize", "--block-size"],
    [["file", "--no-blockSize"], "--no-blockSize", "--no-block-size"],
  ])(
    "refuses the schema key spelling %j and names the documented flag",
    (argv, flag, documented) => {
      expect(failure(argv)).toEqual({
        kind: "flag_spelling",
        message: `Unknown flag: ${flag}. Did you mean ${documented}?`,
        flag,
        documented,
      });
    },
  );

  it("stacks short aliases when all but the last are booleans", () => {
    expect(bound(["file", "-ym", "a"]).options).toMatchObject({
      yes: true,
      mode: "a",
    });
    expect(failure(["file", "-my"])).toEqual({
      kind: "parse",
      message: "Non-boolean flag -m must be last in a stacked alias",
    });
  });

  it.each([
    [["file", "--nope"], "Unknown flag: --nope"],
    [["file", "--nope=1"], "Unknown flag: --nope"],
    [["file", "--no-nope"], "Unknown flag: --no-nope"],
    [["file", "--no-blockSize=1"], "Unknown flag: --no-blockSize=1"],
    [["file", "-z"], "Unknown flag: -z"],
    [["file", "--"], "Unknown flag: --"],
    [["file", "--block-size"], "Missing value for flag: --block-size"],
    [["file", "-m"], "Missing value for flag: -m"],
  ])("refuses %j with the message REA prints", (argv, message) => {
    expect(failure(argv)).toEqual({ kind: "parse", message });
  });

  it("reports schema failures as field errors", () => {
    // Positionals are validated first, so the missing path is reported alone.
    expect(failure(["--block-size", "abc", "--mode", "c"])).toMatchObject({
      kind: "validation",
      message: "Invalid input: expected string, received undefined",
      fieldErrors: [
        {
          code: "invalid_type",
          missing: true,
          path: "path",
          expected: "string",
          received: "",
          message: "Invalid input: expected string, received undefined",
        },
      ],
    });
    // Captured from incur 0.6.1's Parser.parse with the same schema and argv.
    expect(
      failure(["file", "--block-size", "abc", "--mode", "c"]),
    ).toMatchObject({
      kind: "validation",
      message:
        'Invalid input: expected number, received NaN; Invalid option: expected one of "a"|"b"',
      fieldErrors: [
        {
          code: "invalid_type",
          missing: false,
          path: "blockSize",
          expected: "number",
          received: "NaN",
          message: "Invalid input: expected number, received NaN",
        },
        {
          code: "invalid_value",
          missing: false,
          path: "mode",
          expected: "",
          received: "",
          message: 'Invalid option: expected one of "a"|"b"',
        },
      ],
    });
  });

  it("adds one per occurrence of a count option, stacked or spelled out", () => {
    const counted = {
      options: z.object({
        verbosity: z.number().default(0).meta({ count: true }),
        yes: z.boolean().optional(),
      }),
      alias: { verbosity: "v", yes: "y" },
    };
    expect(bound(["-vyv", "--verbosity"], counted).options).toEqual({
      verbosity: 3,
      yes: true,
    });
  });
});
