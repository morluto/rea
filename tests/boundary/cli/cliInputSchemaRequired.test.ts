import { Ajv2020 } from "ajv/dist/2020.js";
import { Cli, z } from "incur";
import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import { createCliInventory } from "../../../scripts/lib/product-catalog.mjs";

type CliInstance = ReturnType<typeof createCli>;
type CommandMap = NonNullable<ReturnType<typeof Cli.toCommands.get>>;

const INPUT_GROUPS = ["args", "options"] as const;
const registeredCommands: WeakMap<object, CommandMap> = Cli.toCommands;

const advertisedGroupSchema = z
  .object({
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).optional(),
  })
  .loose();
const advertisedInputSchema = z.object({
  args: advertisedGroupSchema.optional(),
  options: advertisedGroupSchema.optional(),
});

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

const advertisedSchema = async (cli: CliInstance, command: string) => {
  const result = await serve(cli, [command, "--schema", "--json"]);
  expect(result.exitCode, command).toBe(0);
  return advertisedInputSchema.parse(JSON.parse(result.stdout));
};

const parserSchema = (
  cli: CliInstance,
  command: string,
  group: (typeof INPUT_GROUPS)[number],
): z.ZodObject | undefined => {
  const entry = registeredCommands.get(cli)?.get(command);
  if (entry === undefined || !(group in entry)) return undefined;
  const schema: unknown = Reflect.get(entry, group);
  return schema instanceof z.ZodObject ? schema : undefined;
};

const omissionRejected = (schema: z.ZodObject | undefined): string[] =>
  Object.entries(schema?.shape ?? {})
    .filter(([, field]) => !field.safeParse(undefined).success)
    .map(([key]) => key)
    .sort();

describe("CLI advertised input schemas", () => {
  it("require exactly the inputs whose omission the parser rejects", async () => {
    const cli = createCli({});
    const mismatches: string[] = [];
    for (const command of createCliInventory(cli).primary) {
      const advertised = await advertisedSchema(cli, command);
      for (const group of INPUT_GROUPS) {
        const required = (advertised[group]?.required ?? []).toSorted();
        const rejected = omissionRejected(parserSchema(cli, command, group));
        if (required.join() !== rejected.join())
          mismatches.push(
            `${command} ${group}: advertised [${required.join()}], parser rejects [${rejected.join()}]`,
          );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("accepts the one-argument keyed-archive call and keeps its constraints", async () => {
    const cli = createCli({});
    const advertised = await advertisedSchema(cli, "inspect-keyed-archive");
    const ajv = new Ajv2020({ strict: false });
    const args = ajv.compile(advertised.args ?? {});
    const options = ajv.compile(advertised.options ?? {});

    expect(args({ path: "./keyed.plist" })).toBe(true);
    expect(args({})).toBe(false);
    expect(options({})).toBe(true);
    expect(options({ limit: 0 })).toBe(false);
    expect(advertised.args?.properties?.["archive"]).toMatchObject({
      default: ".",
    });
    expect(advertised.options?.properties?.["limit"]).toMatchObject({
      default: 20_000,
      minimum: 1,
    });
    expect(
      parserSchema(cli, "inspect-keyed-archive", "args")?.parse({ path: "x" }),
    ).toEqual({ path: "x", archive: "." });

    const help = await serve(cli, ["inspect-keyed-archive", "--help"]);
    expect(help.stdout).toContain(
      "Usage: rea inspect-keyed-archive <path> [archive] [options]",
    );
    expect(help.stdout).toContain(
      "archive  Relative archive path when the target is a bundle",
    );
  });
});
