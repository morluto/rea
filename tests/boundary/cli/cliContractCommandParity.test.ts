import { Parser, z } from "incur";
import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import {
  contractCommandBindings,
  type ContractCommandBinding,
} from "../../../src/cli/contractCommand.js";
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
const bindings = contractCommandBindings(cli);

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
  binding: ContractCommandBinding["fields"][number],
  contractField: z.ZodType,
  value: unknown,
): boolean => {
  if (binding.callerPath) {
    // A caller path is validated as typed: an empty value never becomes the
    // working directory. A nonempty value is resolved, then the contract rules.
    if (typeof value !== "string") return admits(contractField, value);
    return value !== "" && admits(contractField, absoluteCallerPath(value));
  }
  if (typeof value === "string" && isNumeric(contractField))
    return DECIMAL_TOKEN.test(value) && admits(contractField, Number(value));
  return admits(contractField, value);
};

describe("CLI commands projected from tool contracts", () => {
  it("registers the migrated commands", () => {
    expect(bindings.map((binding) => binding.command)).toEqual(
      expect.arrayContaining([
        "inspect-sqlite-database",
        "inspect-elf-notes",
        "inspect-pe-resources",
        "inspect-devicetree",
        "inspect-go-binary",
        "inspect-v8-code-cache",
      ]),
    );
  });

  it.each(bindings.map((binding) => [binding.command, binding] as const))(
    "%s exposes every contract field or declares its omission",
    (_command, binding) => {
      const contractFields = Object.keys(binding.contract.inputSchema.shape);
      expect(
        [...binding.fields.map((field) => field.field), ...binding.omitted]
          .toSorted()
          .join(),
      ).toBe(contractFields.toSorted().join());
      const command = registered.get(binding.command)!;
      const argKeys = Object.keys(
        (command.args as z.ZodObject | undefined)?.shape ?? {},
      );
      const optionKeys = Object.keys(
        (command.options as z.ZodObject | undefined)?.shape ?? {},
      );
      expect(argKeys).toEqual(
        binding.fields.filter((field) => field.positional).map((f) => f.key),
      );
      expect(optionKeys.toSorted()).toEqual(
        [
          ...binding.fields
            .filter((field) => !field.positional)
            .map((field) => field.key),
          ...binding.cliOnly,
        ].toSorted(),
      );
    },
  );

  it.each(bindings.map((binding) => [binding.command, binding] as const))(
    "%s admits exactly what its contract admits",
    (_command, binding) => {
      const command = registered.get(binding.command)!;
      const contractShape = binding.contract.inputSchema.shape as Record<
        string,
        z.ZodType
      >;
      const mismatches: string[] = [];
      for (const field of binding.fields) {
        const group = (
          field.positional ? command.args : command.options
        ) as z.ZodObject;
        const cliField = group.shape[field.key] as z.ZodType;
        const contractField = contractShape[field.field]!;
        // Incur's help reads flag and choice types only through `optional`.
        expect(cliField, field.key).not.toBeInstanceOf(z.ZodExactOptional);
        if (field.callerPath) {
          // Only the absolute-path rule is relaxed, and only by resolution.
          expect(admits(contractField, "rel/x"), field.field).toBe(false);
          expect(admits(contractField, absoluteCallerPath("rel/x"))).toBe(true);
        }
        for (const value of probes(contractField)) {
          const expected = expectedAdmission(field, contractField, value);
          if (admits(cliField, value) !== expected)
            mismatches.push(
              `${field.key}=${JSON.stringify(value)} expected ${String(expected)}`,
            );
        }
      }
      expect(mismatches).toEqual([]);
    },
  );

  it.each(bindings.map((binding) => [binding.command, binding] as const))(
    "%s takes each boolean contract field as a bare flag",
    (_command, binding) => {
      const command = registered.get(binding.command)!;
      const contractShape = binding.contract.inputSchema.shape as Record<
        string,
        z.ZodType
      >;
      for (const field of binding.fields) {
        if (
          field.positional ||
          inputJsonSchema(contractShape[field.field]!).type !== "boolean"
        )
          continue;
        const options = z.object({
          [field.key]: (command.options as z.ZodObject).shape[field.key]!,
        });
        const flag = `--${field.key.replaceAll(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)}`;
        expect(Parser.parse([flag], { options }).options, flag).toEqual({
          [field.key]: true,
        });
      }
    },
  );

  it.each(bindings.map((binding) => [binding.command, binding] as const))(
    "%s maps parsed argv to an admitted contract input",
    (_command, binding) => {
      const command = registered.get(binding.command)!;
      const args = Object.fromEntries(
        binding.fields
          .filter((field) => field.positional)
          .map((field) => [field.key, "rel/target"]),
      );
      const options = (command.options as z.ZodObject).parse({});
      const input = binding.toContractInput(args, options);
      expect(binding.contract.inputSchema.safeParse(input).error).toBe(
        undefined,
      );
      for (const field of binding.fields.filter((each) => each.callerPath))
        if (field.positional)
          expect(input[field.field]).toBe(absoluteCallerPath("rel/target"));
    },
  );
});
