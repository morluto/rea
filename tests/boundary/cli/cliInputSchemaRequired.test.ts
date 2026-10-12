import { Ajv2020 } from "ajv/dist/2020.js";
import { Cli, z } from "incur";
import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import { createCliInventory } from "../../../scripts/lib/catalog-cli.mjs";

type CliInstance = ReturnType<typeof createCli>;
type CommandMap = NonNullable<ReturnType<typeof Cli.toCommands.get>>;

const INPUT_GROUPS = ["args", "options"] as const;
const registeredCommands: WeakMap<object, CommandMap> = Cli.toCommands;

const advertisedGroupSchema = z
  .object({
    properties: z.record(z.string(), z.unknown()),
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
        const parser = parserSchema(cli, command, group);
        const advertisedGroup = advertised[group];
        if (parser === undefined) {
          if (advertisedGroup !== undefined)
            mismatches.push(`${command} ${group}: advertised without parser`);
          continue;
        }
        if (advertisedGroup === undefined) {
          mismatches.push(`${command} ${group}: parser group not advertised`);
          continue;
        }
        const parserProperties = Object.keys(parser.shape).toSorted();
        const advertisedProperties = Object.keys(
          advertisedGroup.properties,
        ).toSorted();
        if (advertisedProperties.join() !== parserProperties.join())
          mismatches.push(
            `${command} ${group}: advertised properties [${advertisedProperties.join()}], parser properties [${parserProperties.join()}]`,
          );
        const required = (advertisedGroup.required ?? []).toSorted();
        const rejected = omissionRejected(parser);
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

describe("firmware CLI advertised input schema", () => {
  it("keeps limits and defaults from its shared input contract", async () => {
    const cli = createCli({});
    const advertised = await advertisedSchema(cli, "extract-firmware");
    const ajv = new Ajv2020({ strict: false });
    const args = ajv.compile(advertised.args ?? {});
    const options = ajv.compile(advertised.options ?? {});

    expect(args({ path: "firmware.bin", outputDirectory: "output" })).toBe(
      true,
    );
    expect(args({ path: "", outputDirectory: "output" })).toBe(false);
    expect(args({ path: "firmware.bin", outputDirectory: "" })).toBe(false);
    expect(options({})).toBe(true);
    expect(options({ maxDepth: 0 })).toBe(false);
    expect(options({ maxDepth: 11 })).toBe(false);
    expect(options({ maxOutputBytes: 0 })).toBe(false);
    expect(options({ maxOutputBytes: 512 * 1024 * 1024 + 1 })).toBe(false);
    expect(options({ maxOutputFiles: 100_001 })).toBe(false);
    expect(advertised.options?.properties?.["maxDepth"]).toMatchObject({
      default: 3,
    });
    expect(advertised.options?.properties?.["maxOutputBytes"]).toMatchObject({
      default: 256 * 1024 * 1024,
    });
    expect(advertised.options?.properties?.["maxOutputFiles"]).toMatchObject({
      default: 10_000,
    });

    const maxOffset = Number.MAX_SAFE_INTEGER;
    expect(options({ offset: maxOffset + 1 })).toBe(false);
    expect(options({ length: maxOffset + 1 })).toBe(false);

    expect(
      parserSchema(cli, "extract-firmware", "options")?.parse({}),
    ).toMatchObject({
      maxDepth: 3,
      maxOutputBytes: 256 * 1024 * 1024,
      maxOutputFiles: 10_000,
    });
  });
});

describe("web module CLI advertised input schema", () => {
  it("advertises the shared path and URL constraints", async () => {
    const cli = createCli({});
    const advertised = await advertisedSchema(cli, "trace-web-module-imports");
    const ajv = new Ajv2020({ strict: false });
    const args = ajv.compile(advertised.args ?? {});
    const options = ajv.compile(advertised.options ?? {});

    expect(
      args({ manifestPath: resolve("manifest.json"), scriptIndex: 0 }),
    ).toBe(true);
    expect(args({ manifestPath: "", scriptIndex: 0 })).toBe(false);
    expect(args({ manifestPath: "manifest\u0000.json", scriptIndex: 0 })).toBe(
      false,
    );
    expect(args({ manifestPath: "./manifest.json", scriptIndex: -1 })).toBe(
      false,
    );
    expect(options({})).toBe(true);
    expect(options({ importerUrl: "" })).toBe(false);
    expect(options({ importMapPath: "" })).toBe(false);
    expect(options({ importMapPath: "map\u0000.json" })).toBe(false);
    expect(options({ importMapBaseUrl: "" })).toBe(false);
  });
});
import { resolve } from "node:path";
