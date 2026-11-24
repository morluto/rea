import { Ajv2020 } from "ajv/dist/2020.js";
import { parseCliArgv } from "../../../src/cli/argvParser.js";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import { cliCommands } from "../../../src/cli/commandRegistry.js";
import { commandInputJsonSchema } from "../../../src/cli/commandManifests.js";

const NON_DECIMAL = ["0x10", "1e3"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numericBranches = (schema: unknown): boolean => {
  if (!isRecord(schema)) return false;
  if (schema.type === "integer" || schema.type === "number") return true;
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.some(numericBranches)) return true;
  }
  return false;
};

const bounds = (
  schema: unknown,
): Array<{ min: number; max: number; candidate: number }> => {
  if (!isRecord(schema)) return [];
  const nested = ["anyOf", "oneOf", "allOf"].flatMap((key) =>
    Array.isArray(schema[key]) ? schema[key].flatMap(bounds) : [],
  );
  if (schema.type !== "integer" && schema.type !== "number") return nested;
  const min =
    typeof schema.exclusiveMinimum === "number"
      ? schema.exclusiveMinimum + 1
      : typeof schema.minimum === "number"
        ? schema.minimum
        : 0;
  const max =
    typeof schema.exclusiveMaximum === "number"
      ? schema.exclusiveMaximum - 1
      : typeof schema.maximum === "number"
        ? schema.maximum
        : Number.MAX_SAFE_INTEGER;
  const preferred =
    typeof schema.default === "number" &&
    schema.default >= min &&
    schema.default <= max
      ? schema.default
      : min;
  return Number.isSafeInteger(preferred) && preferred >= min && preferred <= max
    ? [...nested, { min, max, candidate: preferred }]
    : nested;
};

const flagName = (name: string): string =>
  `--${name.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`)}`;

/** Fields whose decimal admission this catalog must actually exercise. */
const REQUIRED_NUMERIC_FIELDS = [
  "read-bytes options.length",
  "search-bytes options.limit",
  "read-adb-logcat options.count",
  "read-adb-logcat options.pid",
  "inspect-sqlite-database options.rowLimit",
  "decompile-all options.limit",
  "instrument-with-frida options.durationMs",
  "compare-web-screenshots options.channelThreshold",
  "inspect-byte-entropy options.blockSize",
  "inspect-elf-notes options.maxFileBytes",
  "inspect-native-initializers options.limit",
  "inspect-web-page options.observationMs",
  "observe-web-execution options.observationMs",
  "extract-firmware options.maxDepth",
  "trace-web-source-location args.line",
  "cutter-command args.expectedGeneration",
  "observe-native-ui options.maxNodes",
  "inspect-web-network-capture options.record",
  "environment-serve options.port",
] as const;

/** Decimal argv tokens the parser admits as numbers, for fields advertised as strings. */
const PROBE_TOKENS = ["0", "1"] as const;

describe("decimal integer CLI admission", () => {
  it("rejects 0x10 and 1e3 for every numeric input and keeps an in-range decimal", () => {
    const cli = createCli({});
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const failures: string[] = [];
    const checked: string[] = [];
    cliCommands(cli).forEach(({ definition: command, name: path }) => {
      for (const group of ["args", "options"] as const) {
        const parser = command[group];
        if (!(parser instanceof z.ZodObject)) continue;
        const advertised = commandInputJsonSchema(parser);
        if (!isRecord(advertised) || !isRecord(advertised.properties)) continue;
        for (const [name, property] of Object.entries(advertised.properties)) {
          const field = parser.shape[name];
          if (field === undefined) {
            failures.push(
              `${path} ${group}.${name}: advertised without parser`,
            );
            continue;
          }
          const label = `${path} ${group}.${name}`;
          // A repeated option parses each argv token as one array item.
          const repeated = isRecord(property) && property.type === "array";
          const item = repeated ? property.items : property;
          const isolated = z.object({ [name]: field });
          const read = (token: string): unknown => {
            const parsed =
              group === "options"
                ? parseCliArgv([flagName(name), token], { options: isolated })
                : parseCliArgv([token], { args: isolated });
            if (!parsed.ok) throw new Error(parsed.error.message);
            const value = (
              group === "options" ? parsed.value.options : parsed.value.args
            )[name];
            return repeated && Array.isArray(value) ? value[0] : value;
          };
          const readsNumber = (token: string): boolean => {
            try {
              return typeof read(token) === "number";
            } catch {
              return false;
            }
          };
          // String-advertised token grammars (for example --port) still count.
          const probed = PROBE_TOKENS.find(readsNumber);
          if (!numericBranches(item) && probed === undefined) continue;
          let validate: ((value: unknown) => boolean) | undefined;
          try {
            validate = ajv.compile(item as Parameters<Ajv2020["compile"]>[0]);
          } catch (error) {
            failures.push(
              `${label}: Ajv could not compile the advertised schema (${error instanceof Error ? error.message : String(error)})`,
            );
            continue;
          }
          for (const token of NON_DECIMAL) {
            if (validate(token))
              failures.push(`${label}: advertised schema accepts ${token}`);
          }
          for (const token of NON_DECIMAL) {
            try {
              read(token);
              failures.push(`${label}: CLI parser accepts ${token}`);
            } catch {
              // Decimal tokens are the only numeric spelling.
            }
          }
          const range = bounds(item)[0];
          const candidate =
            range?.candidate ??
            (probed === undefined ? undefined : Number(probed));
          if (candidate === undefined) {
            failures.push(`${label}: no in-range decimal candidate`);
            continue;
          }
          const decimal = String(candidate);
          if (range !== undefined) {
            for (const value of [range.min - 1, range.max + 1]) {
              if (value < 0) continue;
              for (const token of [String(value), `000${value}`]) {
                if (validate(token))
                  failures.push(
                    `${label}: advertised schema accepts out-of-range ${token}`,
                  );
              }
            }
          }
          try {
            expect(read(decimal)).toBe(candidate);
          } catch (error) {
            failures.push(
              `${label}: decimal ${decimal} did not parse (${error instanceof Error ? error.message : String(error)})`,
            );
            continue;
          }
          const admitsLeadingZeros = validate(`0${decimal}`);
          try {
            const parsed = read(`0${decimal}`);
            if (parsed !== candidate)
              failures.push(
                `${label}: leading-zero decimal parsed as ${String(parsed)}, not ${String(candidate)}`,
              );
          } catch (error) {
            if (admitsLeadingZeros)
              failures.push(
                `${label}: leading-zero decimal was rejected (${error instanceof Error ? error.message : String(error)})`,
              );
          }
          // Argv supplies text, so the advertisement must admit the token itself.
          if (!validate(decimal))
            failures.push(
              `${label}: advertised schema rejects in-range token "${decimal}"`,
            );
          checked.push(label);
        }
      }
    });
    expect(checked).toEqual(
      expect.arrayContaining([...REQUIRED_NUMERIC_FIELDS]),
    );
    expect(checked.length).toBeGreaterThan(REQUIRED_NUMERIC_FIELDS.length);
    expect(new Set(checked).size).toBe(checked.length);
    expect(failures).toEqual([]);
  });
});

describe("decimal integer CLI advertisement", () => {
  const schemaOf = async (command: string): Promise<unknown> => {
    let stdout = "";
    let exitCode = 0;
    await createCli({}).serve([command, "--schema", "--json"], {
      env: {},
      exit: (code) => {
        exitCode = code;
      },
      stdout: (text) => {
        stdout += text;
      },
    });
    expect(exitCode, command).toBe(0);
    return JSON.parse(stdout) as unknown;
  };

  it("publishes the token range in --schema for arguments and options", async () => {
    const validateToken = (schema: unknown, token: string): boolean =>
      new Ajv2020({ strict: false }).compile(
        schema as Parameters<Ajv2020["compile"]>[0],
      )(token) === true;
    const location = await schemaOf("trace-web-source-location");
    const line = (location as { args: { properties: { line: unknown } } }).args
      .properties.line;
    expect(line).toMatchObject({
      description: "One-based generated line",
      anyOf: [{ type: "integer", minimum: 1 }, { type: "string" }],
    });
    for (const token of ["1", "0001"])
      expect(validateToken(line, token), token).toBe(true);
    for (const token of ["0", "0000"])
      expect(validateToken(line, token), token).toBe(false);

    const capture = await schemaOf("inspect-web-network-capture");
    const record = (
      capture as {
        options: { properties: { record: { items: unknown } } };
      }
    ).options.properties.record.items;
    expect(record).toMatchObject({
      anyOf: [{ type: "integer", minimum: 0 }, { type: "string" }],
    });
    for (const token of ["0", "03"])
      expect(validateToken(record, token), token).toBe(true);
    expect(validateToken(record, "-1")).toBe(false);

    expect(await schemaOf("environment-serve")).toMatchObject({
      options: {
        properties: {
          port: { type: "string", pattern: "^(?:0|[1-9]\\d*)$" },
        },
      },
    });
  });
});
