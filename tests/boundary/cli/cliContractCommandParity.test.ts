import { Parser, z } from "incur";
import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import {
  describeContractCommand,
  type ContractCliDescription,
  type ContractCliParameter,
} from "../../../src/cli/contractCliDescription.js";
import { contractCommandDescriptions } from "../../../src/cli/contractCommand.js";
import {
  visitRegisteredCommands,
  type RegisteredCommand,
} from "../../../src/cli/visitRegisteredCommands.js";
import { absoluteCallerPath } from "../../../src/filesystem/callerPath.js";

const DECIMAL_TOKEN = /^[0-9]+$/u;

const cli = createCli({});
const registered = new Map<string, RegisteredCommand>();
visitRegisteredCommands(cli, (command, path) => {
  registered.set(path, command);
});
const descriptions = contractCommandDescriptions(cli);

const inputJsonSchema = (field: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(field, { io: "input", unrepresentable: "any" });

/** Values at and around each advertised bound, plus spellings argv can carry. */
const probes = (field: z.ZodType): readonly unknown[] => {
  const json = inputJsonSchema(field);
  const values: unknown[] = [
    undefined,
    null,
    "",
    "\0",
    "a\0b",
    "\uD800",
    "x",
    "rel/x",
    "/abs/x",
    true,
    false,
    -1,
    0,
    1,
    1.5,
    64,
    4096,
    2 ** 31,
    2 ** 53,
    [],
    ["x"],
    [""],
    ["a\0b"],
    "0",
    "1",
    "010",
    "0x10",
    "1e3",
    "+1",
    " 1",
    "-1",
    "1.5",
  ];
  for (const bound of ["minimum", "maximum", "minLength", "maxLength"]) {
    const value = json[bound];
    if (typeof value !== "number") continue;
    const near = [value - 1, value, value + 1];
    values.push(...near, ...near.filter((n) => n >= 0).map(String));
    if (bound.endsWith("Length"))
      values.push(...near.filter((n) => n >= 0).map((n) => "x".repeat(n)));
  }
  if (Array.isArray(json.enum)) values.push(...json.enum, `${json.enum[0]}!`);
  return values;
};

const isNumeric = (field: z.ZodType): boolean => {
  const json = inputJsonSchema(field);
  return json.type === "integer" || json.type === "number";
};

/** Argv omission is an absent key, never an explicit undefined. */
const admits = (field: z.ZodType, value: unknown): boolean =>
  value === undefined
    ? z.object({ value: field }).safeParse({}).success
    : field.safeParse(value).success;

/** What the contract admits for one value the caller typed on the CLI. */
const expectedAdmission = (
  parameter: ContractCliParameter,
  contractField: z.ZodType,
  value: unknown,
): boolean => {
  if (parameter.callerPath) {
    // A caller path is validated as typed: an empty value never becomes the
    // working directory. A nonempty value is resolved, then the contract rules.
    if (typeof value !== "string") return admits(contractField, value);
    return value !== "" && admits(contractField, absoluteCallerPath(value));
  }
  if (typeof value === "string" && isNumeric(contractField))
    return DECIMAL_TOKEN.test(value) && admits(contractField, Number(value));
  return admits(contractField, value);
};

const registeredField = (
  description: ContractCliDescription,
  parameter: ContractCliParameter,
): z.ZodType => {
  const command = registered.get(description.command)!;
  const group = (
    parameter.positional ? command.args : command.options
  ) as z.ZodObject;
  return group.shape[parameter.key] as z.ZodType;
};

const contractShape = (description: ContractCliDescription) =>
  description.contract.inputSchema.shape as Record<string, z.ZodType>;

const each = descriptions.map(
  (description) => [description.command, description] as const,
);

describe("CLI commands projected from tool contracts", () => {
  it("registers the migrated commands", () => {
    expect(descriptions.map(({ command }) => command)).toEqual(
      expect.arrayContaining([
        "inspect-sqlite-database",
        "inspect-elf-notes",
        "inspect-pe-resources",
      ]),
    );
  });

  it.each(each)(
    "%s exposes every contract field or declares its omission",
    (_command, description) => {
      expect(
        [
          ...description.parameters.map(({ field }) => field),
          ...Object.keys(description.omitted),
        ]
          .toSorted()
          .join(),
      ).toBe(Object.keys(contractShape(description)).toSorted().join());
      const command = registered.get(description.command)!;
      const argKeys = Object.keys(
        (command.args as z.ZodObject | undefined)?.shape ?? {},
      );
      const optionKeys = Object.keys(
        (command.options as z.ZodObject | undefined)?.shape ?? {},
      );
      expect(argKeys).toEqual(
        description.parameters
          .filter(({ positional }) => positional)
          .map(({ key }) => key),
      );
      expect(optionKeys.toSorted()).toEqual(
        description.parameters
          .filter(({ positional }) => !positional)
          .map(({ key }) => key)
          .toSorted(),
      );
    },
  );

  it.each(each)(
    "%s admits exactly what its contract admits",
    (_command, description) => {
      const mismatches: string[] = [];
      for (const parameter of description.parameters) {
        const cliField = registeredField(description, parameter);
        const contractField = contractShape(description)[parameter.field]!;
        // Incur's help reads flag and choice types only through `optional`.
        expect(cliField, parameter.key).not.toBeInstanceOf(z.ZodExactOptional);
        if (parameter.callerPath) {
          // Only the absolute-path rule is relaxed, and only by resolution.
          expect(admits(contractField, "rel/x"), parameter.field).toBe(false);
          expect(admits(contractField, absoluteCallerPath("rel/x"))).toBe(true);
        }
        for (const value of probes(contractField)) {
          const expected = expectedAdmission(parameter, contractField, value);
          if (admits(cliField, value) !== expected)
            mismatches.push(
              `${parameter.key}=${JSON.stringify(value)} expected ${String(expected)}`,
            );
        }
      }
      expect(mismatches).toEqual([]);
    },
  );

  it.each(each)(
    "%s takes each boolean contract field as a bare flag",
    (_command, description) => {
      for (const parameter of description.parameters) {
        if (parameter.positional || !parameter.booleanFlag) continue;
        const options = z.object({
          [parameter.key]: registeredField(description, parameter),
        });
        const flag = `--${parameter.key.replaceAll(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)}`;
        expect(Parser.parse([flag], { options }).options, flag).toEqual({
          [parameter.key]: true,
        });
      }
    },
  );

  it.each(each)(
    "%s maps parsed argv to an admitted contract input",
    (_command, description) => {
      const command = registered.get(description.command)!;
      const values = {
        ...(command.options as z.ZodObject).parse({}),
        ...Object.fromEntries(
          description.parameters
            .filter(({ positional }) => positional)
            .map(({ key }) => [key, "rel/target"]),
        ),
      };
      const input = description.toContractInput(values);
      expect(description.contract.inputSchema.safeParse(input).error).toBe(
        undefined,
      );
      for (const parameter of description.parameters)
        if (parameter.callerPath && parameter.positional) {
          expect(input[parameter.field]).toBe(absoluteCallerPath("rel/target"));
          expect(description.callerInputs(values)[parameter.field]).toBe(
            "rel/target",
          );
        }
    },
  );

  it.each([
    ["an object", z.object({ value: z.string() }).optional()],
    ["a record", z.record(z.string(), z.string()).optional()],
    ["a union", z.union([z.string(), z.boolean()]).optional()],
    ["a pipe", z.string().pipe(z.string()).optional()],
    ["an array of objects", z.array(z.object({})).optional()],
    ["an array of numbers", z.array(z.number()).optional()],
    ["a tuple", z.tuple([z.string()]).optional()],
  ])("refuses to describe a field that is %s", (_kind, field) => {
    expect(() =>
      describeContractCommand(
        { name: "probe", inputSchema: z.object({ field }) },
        { command: "probe", description: "Probe" },
      ),
    ).toThrow("probe.field has no argv projection");
  });

  it("refuses an input constraint the CLI schema cannot carry", () => {
    expect(() =>
      describeContractCommand(
        {
          name: "probe",
          inputSchema: z
            .object({ value: z.string().optional() })
            .meta({ not: { required: ["value"] } }),
        },
        { command: "probe", description: "Probe" },
      ),
    ).toThrow("probe input keyword not has no CLI projection");
  });
});
