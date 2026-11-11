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
  if (Array.isArray(schema.enum)) {
    const members = schema.enum.filter(Number.isSafeInteger) as number[];
    const preferred =
      typeof schema.default === "number" && members.includes(schema.default)
        ? schema.default
        : members[0];
    return preferred === undefined
      ? nested
      : [...nested, { min: preferred, max: preferred }];
  }
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
  "execute-rizin-command options.asmBits",
] as const;

/** The first non-negative integer outside a numeric enum, if the schema has one. */
const nonMember = (schema: unknown): number | undefined => {
  if (!isRecord(schema)) return undefined;
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const found = nonMember(branch);
      if (found !== undefined) return found;
    }
  }
  if (!Array.isArray(schema.enum)) return undefined;
  const members = new Set(schema.enum);
  let value = 0;
  while (members.has(value)) value += 1;
  return value;
};

/** A literal set must not advertise or parse a decimal token outside it. */
const nonMemberFailures = (
  label: string,
  property: unknown,
  validate: (value: unknown) => boolean,
  read: (token: string) => unknown,
): readonly string[] => {
  const outside = nonMember(property);
  if (outside === undefined) return [];
  const failures: string[] = [];
  if (validate(String(outside)) || validate(outside))
    failures.push(`${label}: advertised schema accepts non-member ${outside}`);
  try {
    read(String(outside));
    failures.push(`${label}: Parser.parse accepts non-member ${outside}`);
  } catch {
    // Only the declared members parse.
  }
  return failures;
};

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
          if (!numericBranches(property)) continue;
          const field = parser.shape[name];
          if (field === undefined) {
            failures.push(
              `${path} ${group}.${name}: advertised without parser`,
            );
            continue;
          }
          const label = `${path} ${group}.${name}`;
          let validate: ((value: unknown) => boolean) | undefined;
          try {
            validate = ajv.compile(
              property as Parameters<Ajv2020["compile"]>[0],
            );
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
          const isolated = z.object({ [name]: field });
          const read = (token: string): unknown => {
            if (group === "options") {
              return Parser.parse([flagName(name), token], {
                options: isolated,
              }).options[name];
            }
            return Parser.parse([token], { args: isolated }).args[name];
          };
          for (const token of NON_DECIMAL) {
            try {
              read(token);
              failures.push(`${label}: Parser.parse accepts ${token}`);
            } catch {
              // Decimal tokens are the only numeric spelling.
            }
          }
          const candidate = bounds(property)[0]?.min;
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
          const admitsLeadingZeros =
            JSON.stringify(property).includes("^[0-9]+$");
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
          if (!(validate(decimal) || validate(candidate)))
            failures.push(
              `${label}: advertised schema rejects in-range ${decimal}`,
            );
          failures.push(...nonMemberFailures(label, property, validate, read));
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
