import { Ajv2020 } from "ajv/dist/2020.js";
import { Parser, Schema, z } from "incur";
import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import { visitRegisteredCommands } from "../../../src/cli/visitRegisteredCommands.js";

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

const bounds = (schema: unknown): Array<{ min: number; max: number }> => {
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
    ? [...nested, { min: preferred, max }]
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
    visitRegisteredCommands(cli, (command, path) => {
      for (const group of ["args", "options"] as const) {
        const parser = command[group];
        if (!(parser instanceof z.ZodObject)) continue;
        const advertised = Schema.toJsonSchema(parser);
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
                ? Parser.parse([flagName(name), token], { options: isolated })
                    .options[name]
                : Parser.parse([token], { args: isolated }).args[name];
            return repeated && Array.isArray(parsed) ? parsed[0] : parsed;
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
              failures.push(`${label}: Parser.parse accepts ${token}`);
            } catch {
              // Decimal tokens are the only numeric spelling.
            }
          }
          const candidate =
            bounds(item)[0]?.min ??
            (probed === undefined ? undefined : Number(probed));
          if (candidate === undefined) {
            failures.push(`${label}: no in-range decimal candidate`);
            continue;
          }
          const decimal = String(candidate);
          try {
            expect(read(decimal)).toBe(candidate);
          } catch (error) {
            failures.push(
              `${label}: decimal ${decimal} did not parse (${error instanceof Error ? error.message : String(error)})`,
            );
            continue;
          }
          const admitsLeadingZeros = JSON.stringify(item).includes("^[0-9]+$");
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

  it("publishes the token grammar in --schema for arguments and options", async () => {
    const location = await schemaOf("trace-web-source-location");
    expect(location).toMatchObject({
      args: {
        properties: {
          line: {
            description: "One-based generated line",
            anyOf: [
              { type: "integer", minimum: 1 },
              { type: "string", pattern: "^[0-9]+$" },
            ],
          },
        },
      },
    });
    expect(await schemaOf("inspect-web-network-capture")).toMatchObject({
      options: {
        properties: {
          record: {
            type: "array",
            items: {
              anyOf: [
                { type: "integer", minimum: 0 },
                { type: "string", pattern: "^[0-9]+$" },
              ],
            },
          },
        },
      },
    });
    expect(await schemaOf("environment-serve")).toMatchObject({
      options: {
        properties: {
          port: { type: "string", pattern: "^(?:0|[1-9]\\d*)$" },
        },
      },
    });
  });
});
