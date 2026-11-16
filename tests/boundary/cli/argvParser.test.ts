import { z } from "zod";
import { describe, expect, it } from "vitest";

import { parseCliArgv } from "../../../src/cli/argvParser.js";

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

const failure = (argv: readonly string[]) => {
  const result = parseCliArgv(argv, schemas);
  if (result.ok) throw new Error("parse succeeded");
  return result.error;
};

describe("parseCliArgv", () => {
  it("binds kebab-case and camelCase spellings, values and negations", () => {
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
    expect(bound(["file", "--blockSize=512", "--global"]).options).toEqual({
      blockSize: 512,
      global: true,
    });
  });

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
    [["file", "-z"], "Unknown flag: -z"],
    [["file", "--"], "Unknown flag: --"],
    [["file", "--block-size"], "Missing value for flag: --block-size"],
    [["file", "-m"], "Missing value for flag: -m"],
  ])("refuses %j with the message REA prints", (argv, message) => {
    expect(failure(argv)).toEqual({ kind: "parse", message });
  });

  it("reports schema failures as field errors", () => {
    // Positionals are validated first, so the missing path is reported alone.
    expect(failure(["--block-size", "abc", "--mode", "c"])).toEqual({
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
    expect(failure(["file", "--block-size", "abc", "--mode", "c"])).toEqual({
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

  it("reads boolean text as true only for 'true'", () => {
    expect(bound(["file", "--yes=maybe"]).options.yes).toBe(false);
    expect(bound(["file", "--yes=true"]).options.yes).toBe(true);
  });
});
