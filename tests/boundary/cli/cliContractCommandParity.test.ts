import { Parser, z } from "incur";
import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import {
  describeContractCommand,
  describeOperationChoices,
  describeContractDocumentCommand,
  type ContractCliDescription,
  type ContractCliParameter,
} from "../../../src/cli/contractCliDescription.js";
import {
  contractCommandDescriptions,
  contractDocumentCommandDescriptions,
} from "../../../src/cli/contractCommand.js";
import { jsonInputContentSchema } from "../../../src/cli/jsonInputArgument.js";
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
    "{}",
    "[]",
    "null",
    "{",
    '{"input_bytes":1}',
    '{"input_bytes":0}',
    '{"unknown":1}',
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

/** The field admits a number, possibly alongside null. */
const isNumeric = (field: z.ZodType): boolean => {
  const json = inputJsonSchema(field);
  const branches = Array.isArray(json.anyOf)
    ? (json.anyOf as Record<string, unknown>[])
    : [json];
  return branches.some(({ type }) => type === "integer" || type === "number");
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
  // The named option may supply a selector in place of the positional.
  if (parameter.selectorOption !== undefined && value === undefined)
    return true;
  if (parameter.jsonText) {
    // JSON text is decoded once, then the contract field admits the value.
    if (typeof value !== "string")
      return admits(contractField, value) && value === undefined;
    let decoded: unknown;
    try {
      decoded = JSON.parse(value);
    } catch {
      return false;
    }
    return admits(contractField, decoded) && decoded !== undefined;
  }
  if (parameter.nullFlag !== undefined && value === null)
    // Null is spelled by the bare flag, never by the limit option.
    return false;
  if (parameter.callerPath) {
    // A caller path is validated as typed: an empty value never becomes the
    // working directory. A nonempty value is resolved, then the contract rules.
    if (Array.isArray(value))
      return (
        value.every((path) => typeof path === "string" && path !== "") &&
        admits(
          contractField,
          value.map((path: string) => absoluteCallerPath(path)),
        )
      );
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
  description.fields;

/** The contract schema one parameter supplies: a field, or a flattened member. */
const suppliedField = (
  description: ContractCliDescription,
  parameter: ContractCliParameter,
): z.ZodType => {
  const field = contractShape(description)[parameter.field]!;
  if (parameter.member === undefined) return field;
  let object: z.ZodType = field;
  while (object instanceof z.ZodOptional) object = object.unwrap() as z.ZodType;
  return (
    (object as z.ZodObject).shape[parameter.member] as z.ZodType
  ).optional();
};

/** A caller-relative target, or the first probe the argument admits. */
const requiredValue = (
  description: ContractCliDescription,
  parameter: ContractCliParameter,
): unknown =>
  parameter.callerPath
    ? "rel/target"
    : probes(suppliedField(description, parameter)).find(
        (value) =>
          value !== undefined &&
          admits(registeredField(description, parameter), value),
      );

/** Parsed option values plus admitted positionals and required options. */
const argvValues = (
  description: ContractCliDescription,
  options: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const positional: ReadonlySet<string> = new Set(
    description.parameters
      .filter((parameter) => parameter.positional)
      .map(({ key }) => key),
  );
  // A required selector is supplied positionally.
  const required = description.parameters.filter(
    (parameter) =>
      (parameter.selectorOption === undefined
        ? !admits(registeredField(description, parameter), undefined)
        : parameter.selectorOption.required) &&
      !Object.hasOwn(options, parameter.key),
  );
  const filled = Object.fromEntries(
    required.map((parameter) => [
      parameter.key,
      requiredValue(description, parameter),
    ]),
  );
  return {
    ...Object.fromEntries(
      Object.entries(options).filter(([key]) => positional.has(key)),
    ),
    ...(registered.get(description.command)!.options as z.ZodObject).parse({
      ...Object.fromEntries(
        Object.entries(options).filter(([key]) => !positional.has(key)),
      ),
      ...Object.fromEntries(
        required
          .filter(({ positional }) => !positional)
          .map(({ key }) => [key, filled[key]]),
      ),
    }),
    ...Object.fromEntries(
      required
        .filter(({ positional }) => positional)
        .map(({ key }) => [key, filled[key]]),
    ),
  };
};

/**
 * Argv for commands whose contract rules need more than one value per
 * required field: a selector choice, a pattern grammar or a change to make.
 */
const ARGV_SATISFYING_RULES: Readonly<
  Record<string, Readonly<Record<string, unknown>>>
> = {
  "annotate-native-function": { name: "renamed" },
  "search-bytes": { pattern: "41 ??" },
  "inspect-native-data-type": { type: "/struct" },
  "capture-native-ui-scenario": {
    steps: '[{"kind":"wait","milliseconds":0}]',
  },
};

const each = descriptions.map(
  (description) => [description.command, description] as const,
);

/** Commands whose CLI projection is derived from a tool contract. */
const MIGRATED_COMMANDS = [
  "inspect-sqlite-database",
  "inspect-elf-notes",
  "inspect-pe-resources",
  "inspect-devicetree",
  "inspect-go-binary",
  "inspect-v8-code-cache",
  "inspect-rust-binary",
  "inspect-python-pyc",
  "inspect-erlang-beam",
  "inspect-model-artifact",
  "inspect-apk-signature",
  "inspect-desktop-application",
  "inspect-evm-interface",
  "audit-release-exposure",
  "inspect-il2cpp-metadata",
  "inspect-gpu-code-objects",
  "inspect-signal-decoders",
  "decode-signal-recording",
  "inspect-packet-fields",
  "inspect-packet-capture",
  "inspect-wasm-artifact",
  "inspect-firmware-regions",
  "extract-firmware",
  "inspect-keyed-archive",
  "trace-dylib-resolution",
  "inspect-asset-catalog",
  "decode-interface-builder",
  "annotate-native-function",
  "search-bytes",
  "inspect-native-load-image",
  "read-bytes",
  "address-to-file-offset",
  "trace-native-values",
  "inspect-native-data-type",
  "inspect-native-instruction",
  "resolve-native-call-targets",
  "trace-native-ui-action",
  "inspect-native-dispatch-metadata",
  "procedure-references",
  "inspect-native-api",
  "inspect",
  "xrefs",
  "trace",
  "function",
  "instructions",
  "decompile",
  "search",
  "decompile-all",
  "observe-native-ui",
  "capture-native-ui-scenario",
  "inspect-macho",
  "inspect-signature",
  "list-architectures",
  "inspect-plist",
  "demangle-swift",
];

describe("CLI commands projected from tool contracts", () => {
  it("registers the migrated commands", () => {
    expect(descriptions.map(({ command }) => command)).toEqual(
      expect.arrayContaining(MIGRATED_COMMANDS),
    );
  });

  it.each(each)(
    "%s exposes every contract field or declares its omission",
    (_command, description) => {
      expect(
        [
          ...new Set(description.parameters.map(({ field }) => field)),
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
      expect(argKeys).toEqual([
        ...(description.sessionTarget === undefined
          ? []
          : [description.sessionTarget.key]),
        ...description.parameters
          .filter(({ positional }) => positional)
          .map(({ key }) => key),
      ]);
      expect(optionKeys.toSorted()).toEqual(
        [
          ...description.parameters
            .filter(({ positional }) => !positional)
            .map(({ key }) => key),
          ...(description.sessionTarget?.options ?? []).map(({ key }) => key),
          ...description.cliOnlyOptions.map(({ key }) => key),
          ...description.parameters.flatMap(({ selectorOption }) =>
            [selectorOption, selectorOption?.alternative].flatMap((option) =>
              option === undefined ? [] : [option.key],
            ),
          ),
        ].toSorted(),
      );
    },
  );

  it.each(each)(
    "%s admits exactly what its contract admits",
    (_command, description) => {
      const mismatches: string[] = [];
      for (const parameter of description.parameters) {
        const cliField = registeredField(description, parameter);
        const contractField = suppliedField(description, parameter);
        // Incur's help reads flag and choice types only through `optional`.
        expect(cliField, parameter.key).not.toBeInstanceOf(z.ZodExactOptional);
        if (parameter.callerPath) {
          // Only the absolute-path rule is relaxed, and only by resolution.
          const spelled = (path: string) =>
            parameter.repeatable ? [path] : path;
          expect(admits(contractField, spelled("rel/x")), parameter.field).toBe(
            false,
          );
          expect(
            admits(contractField, spelled(absoluteCallerPath("rel/x"))),
          ).toBe(true);
        }
        if (parameter.runtimeJson !== undefined) {
          // JSON text decoded when the command runs; see below. Argv
          // requires the text of a required field.
          expect(admits(cliField, undefined), parameter.key).toBe(
            admits(contractField, undefined),
          );
          for (const value of ["", "{", "{}"])
            expect(admits(cliField, value), parameter.key).toBe(true);
          continue;
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
    (command, description) => {
      const values = argvValues(
        description,
        ARGV_SATISFYING_RULES[command] ?? {},
      );
      // Runtime JSON text is decoded as admission does.
      for (const { key, runtimeJson } of description.parameters)
        if (runtimeJson !== undefined && typeof values[key] === "string")
          values[key] = JSON.parse(values[key]) as unknown;
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
});

describe("Registration refusals of contract commands", () => {
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

describe("CLI-only options of contract commands", () => {
  it.each(each)(
    "%s keeps its CLI-only options out of the contract input",
    (_command, description) => {
      const cliKeys = description.cliOnlyOptions.map(({ key }) => key);
      const values = Object.fromEntries(cliKeys.map((key) => [key, "set"]));
      const input = description.toContractInput(values);
      for (const key of cliKeys) {
        expect(Object.values(input), key).not.toContain("set");
        expect(Object.keys(description.fields), key).not.toContain(key);
      }
    },
  );

  it("refuses CLI-only options that collide with or depend on unknown keys", () => {
    const contract = {
      name: "probe",
      inputSchema: z.object({ value: z.string().optional() }),
    };
    expect(() =>
      describeContractCommand(contract, {
        command: "probe",
        description: "Probe",
        cliOptions: { value: z.string().optional() },
      }),
    ).toThrow("probe projects two fields to one CLI key");
    expect(() =>
      describeContractCommand(contract, {
        command: "probe",
        description: "Probe",
        cliOptions: { extra: z.string().optional() },
        cliOptionDependencies: { extra: ["missing"] },
      }),
    ).toThrow("probe has no CLI option missing");
    const described = describeContractCommand(contract, {
      command: "probe",
      description: "Probe",
      cliOptions: { extra: z.string().optional() },
      cliOptionDependencies: { extra: ["value"] },
    });
    expect(described.optionConstraints).toEqual({
      dependentRequired: { extra: ["value"] },
    });
    expect(described.cliOptionValues({ value: "a", extra: "b" })).toEqual({
      extra: "b",
    });
    expect(described.toContractInput({ value: "a", extra: "b" })).toEqual({
      value: "a",
    });
  });
});

const decodingAtRunTime = each.filter(([, description]) =>
  description.parameters.some(({ runtimeJson }) => runtimeJson !== undefined),
);

describe("JSON decoded when contract commands run", () => {
  it.each(decodingAtRunTime)(
    "%s refuses text that is not JSON before analysis",
    (_command, description) => {
      for (const parameter of description.parameters) {
        if (parameter.runtimeJson === undefined) continue;
        const malformed = description.admit(
          argvValues(description, {
            detail: "summary",
            evidence_output: "out.json",
            [parameter.key]: "{",
          }),
        );
        expect(malformed.ok, parameter.key).toBe(false);
        if (!malformed.ok)
          expect(malformed.error.issues).toEqual([
            expect.objectContaining({
              path: [parameter.key],
              reason: "invalid_format",
              message: parameter.runtimeJson,
            }),
          ]);
      }
    },
  );

  it.each(decodingAtRunTime)(
    "%s admits what its contract admits once decoded",
    (_command, description) => {
      const mismatches: string[] = [];
      const details = description.evidenceDelivery
        ? (["complete", "summary"] as const)
        : [undefined];
      for (const parameter of description.parameters) {
        if (parameter.runtimeJson === undefined) continue;
        for (const detail of details)
          for (const text of ["{}", "[]", "null", '{"unknown":1}', '["x"]']) {
            const values = argvValues(description, {
              ...(detail === undefined
                ? {}
                : { detail, evidence_output: "out.json" }),
              [parameter.key]: text,
            });
            const expected = description.contract.inputSchema.safeParse({
              ...description.toContractInput({
                ...values,
                [parameter.key]: undefined,
              }),
              ...(detail === undefined ? {} : { detail }),
              [parameter.field]: JSON.parse(text) as unknown,
            }).success;
            if (description.admit(values).ok !== expected)
              mismatches.push(
                `${parameter.key} ${String(detail)} ${text} expected ${String(expected)}`,
              );
          }
      }
      expect(mismatches).toEqual([]);
    },
  );
});

const nullFlagged = each.filter(([, description]) =>
  description.parameters.some(({ nullFlag }) => nullFlag !== undefined),
);

describe("Null-limit flags of contract commands", () => {
  it.each(nullFlagged)(
    "%s spells null with its flag and refuses the flag with a limit",
    (_command, description) => {
      const parameter = description.parameters.find(
        ({ nullFlag }) => nullFlag !== undefined,
      )!;
      const flag = parameter.nullFlag!;
      expect(description.cliOnlyOptions.map(({ key }) => key)).toContain(flag);
      expect(admits(contractShape(description)[parameter.field]!, null)).toBe(
        true,
      );
      const all = argvValues(description, { [flag]: true });
      expect(description.toContractInput(all)[parameter.field]).toBeNull();
      expect(
        description.contract.inputSchema.safeParse(
          description.toContractInput(all),
        ).error,
      ).toBe(undefined);
      expect(description.checkOptions?.(all)).toEqual([]);
      const both = { ...all, [parameter.key]: 1 };
      expect(description.checkOptions?.(both)).toEqual([
        expect.objectContaining({
          path: [flag],
          message: `${flag} and ${parameter.key} are mutually exclusive`,
        }),
      ]);
      expect(description.optionConstraints?.not).toEqual({
        required: [flag, parameter.key],
        properties: { [flag]: { const: true } },
      });
      const bounded = argvValues(description, { [parameter.key]: 1 });
      expect(description.toContractInput(bounded)[parameter.field]).toBe(1);
    },
  );
});

const flattening = each.filter(([, description]) =>
  description.parameters.some(({ member }) => member !== undefined),
);

describe("Flattened object fields of contract commands", () => {
  it.each(flattening)(
    "%s supplies the whole object when any member is given",
    (_command, description) => {
      const members = description.parameters.filter(
        ({ member }) => member !== undefined,
      );
      const field = members[0]!.field;
      expect(
        field in description.toContractInput(argvValues(description, {})),
      ).toBe(false);
      for (const given of members) {
        const input = description.toContractInput(
          argvValues(description, { [given.key]: 1 }),
        );
        expect(Object.keys(input[field] as object).toSorted()).toEqual(
          members.map(({ member }) => member).toSorted(),
        );
        expect((input[field] as Record<string, unknown>)[given.member!]).toBe(
          1,
        );
      }
    },
  );

  it("refuses to flatten part of an object or a non-object field", () => {
    const contract = {
      name: "probe",
      inputSchema: z.object({
        range: z.object({ a: z.number(), b: z.number() }).optional(),
        value: z.string().optional(),
      }),
    };
    expect(() =>
      describeContractCommand(contract, {
        command: "probe",
        description: "Probe",
        flatten: { range: { a: {} } },
      }),
    ).toThrow("probe.range flattens other members");
    expect(() =>
      describeContractCommand(contract, {
        command: "probe",
        description: "Probe",
        flatten: { range: { a: {}, b: {} }, value: { a: {} } },
      }),
    ).toThrow("probe.value is not an optional object");
  });
});

const sessionTargeted = each.filter(
  ([, description]) => description.sessionTarget !== undefined,
);

describe("Session targets of contract commands", () => {
  it.each(sessionTargeted)(
    "%s takes the session target first and keeps it out of the contract input",
    (_command, description) => {
      const target = description.sessionTarget!;
      const command = registered.get(description.command)!;
      const args = (command.args as z.ZodObject).shape;
      expect(Object.keys(args)[0]).toBe(target.key);
      for (const value of ["rel/app", "/abs/app"])
        expect(admits(args[target.key] as z.ZodType, value)).toBe(true);
      for (const value of [undefined, "", "a\0b"])
        expect(admits(args[target.key] as z.ZodType, value)).toBe(false);
      const values = {
        ...argvValues(description, {}),
        [target.key]: "rel/app",
      };
      expect(Object.values(description.toContractInput(values))).not.toContain(
        "rel/app",
      );
      expect(
        Object.values(description.callerInputs(values)).flat(),
      ).not.toContain("rel/app");
    },
  );

  it.each(sessionTargeted)(
    "%s names each renamed contract field by its CLI key in input issues",
    (_command, description) => {
      expect(description.inputBinding.operation).toBe(
        description.contract.name,
      );
      for (const { field, key, member } of description.parameters)
        if (member === undefined)
          expect(description.inputBinding.fields[field]).toBe(
            key === field ? undefined : key,
          );
    },
  );

  it("refuses a session target beside a contract field keyed path", () => {
    expect(() =>
      describeContractCommand(
        { name: "probe", inputSchema: z.object({ path: z.string() }) },
        {
          command: "probe",
          description: "Probe",
          sessionTarget: { description: "Target" },
        },
      ),
    ).toThrow("probe projects two fields to one CLI key");
  });
});

const openingKeys = (description: ContractCliDescription) =>
  description.sessionTarget!.options.map(({ key }) => key);

describe("Opening options of session-targeted contract commands", () => {
  it.each(
    sessionTargeted.filter(
      ([, description]) => description.sessionTarget!.options.length > 0,
    ),
  )(
    "%s keeps opening options out of the contract input",
    (_command, description) => {
      for (const key of openingKeys(description))
        expect(Object.keys(description.fields), key).not.toContain(key);
      expect(
        description.sessionTarget!.admitOpening(description.contract.name, {}),
      ).toEqual({ ok: true, value: {} });
    },
  );

  it.each(
    sessionTargeted.filter(([, description]) =>
      openingKeys(description).includes("entry-point"),
    ),
  )(
    "%s admits a native target interpretation with open_binary",
    (_command, description) => {
      const target = description.sessionTarget!;
      const snapshot = openingKeys(description).includes("snapshot");
      const values = {
        ...argvValues(
          description,
          ARGV_SATISFYING_RULES[description.command] ?? {},
        ),
        [target.key]: "rel/app",
        "target-format": "raw-binary",
        architecture: "x86",
        "entry-point": "0x100",
        provider: "ghidra",
        ...(snapshot ? { snapshot: "rel/snapshot.json" } : {}),
      };
      expect(Object.values(description.toContractInput(values))).not.toContain(
        "0x100",
      );
      // The snapshot is admitted resolved and passed on as typed.
      expect(target.admitOpening(description.contract.name, values)).toEqual({
        ok: true,
        value: {
          format: "raw-binary",
          architecture: "x86",
          entry_point: "0x100",
          provider_id: "ghidra",
          ...(snapshot ? { snapshot_path: "rel/snapshot.json" } : {}),
        },
      });
      // The pairing rule refuses before the target opens and names CLI keys.
      const unpaired = target.admitOpening(description.contract.name, {
        [target.key]: "rel/app",
        "target-format": "raw-binary",
        architecture: "x86",
      });
      expect(unpaired.ok).toBe(false);
      if (!unpaired.ok)
        expect(unpaired.error.issues).toEqual([
          expect.objectContaining({
            path: ["entry-point"],
            message: expect.stringMatching(/requires architecture/u),
          }),
        ]);
      const format = target.options.find(({ key }) => key === "target-format")!;
      expect(admits(format.schema, "raw-binary")).toBe(true);
      expect(admits(format.schema, "esp-flash-image")).toBe(false);
    },
  );

  it.each(
    sessionTargeted.filter(([, description]) =>
      openingKeys(description).includes("flashOffset"),
    ),
  )(
    "%s admits ESP flash options with the opening contract and keeps them out of the contract input",
    (_command, description) => {
      const target = description.sessionTarget!;
      const values = {
        ...argvValues(description, {}),
        [target.key]: "rel/app",
        targetFormat: "esp-flash-image",
        flashOffset: "0x1000",
      };
      for (const { key } of target.options)
        expect(Object.keys(description.fields), key).not.toContain(key);
      expect(Object.values(description.toContractInput(values))).not.toContain(
        "0x1000",
      );
      expect(target.admitOpening(description.contract.name, values)).toEqual({
        ok: true,
        value: { format: "esp-flash-image", flash_offset: "0x1000" },
      });
      expect(target.admitOpening(description.contract.name, {})).toEqual({
        ok: true,
        value: {},
      });
      // The opening contract's pairing rule names the CLI key.
      const unpaired = target.admitOpening(description.contract.name, {
        [target.key]: "rel/app",
        flashOffset: "0x1000",
      });
      expect(unpaired.ok).toBe(false);
      if (!unpaired.ok)
        expect(unpaired.error.issues).toEqual([
          expect.objectContaining({
            path: ["flashOffset"],
            message: expect.stringMatching(/only with format=esp-flash-image/u),
          }),
        ]);
      // Only the projected values of an opening field are admitted.
      const format = target.options.find(({ key }) => key === "targetFormat")!;
      expect(admits(format.schema, "esp-flash-image")).toBe(true);
      expect(admits(format.schema, "raw-binary")).toBe(false);
    },
  );
});

describe("Opening fields a session target projects", () => {
  it("refuses opening fields the opening contract cannot supply", () => {
    const opening = {
      name: "open",
      inputSchema: z.object({
        path: z.string(),
        mode: z.enum(["a", "b"]).optional(),
        required: z.string(),
      }),
    };
    const describeOpening = (
      fields: Record<string, { values?: [string]; callerPath?: true }>,
    ) =>
      describeContractCommand(
        { name: "probe", inputSchema: z.object({}) },
        {
          command: "probe",
          description: "Probe",
          sessionTarget: {
            description: "Target",
            open: { contract: opening, fields },
          },
        },
      );
    expect(() => describeOpening({ missing: {} })).toThrow(
      "open has no option field missing",
    );
    expect(() => describeOpening({ path: {} })).toThrow(
      "open has no option field path",
    );
    expect(() => describeOpening({ required: {} })).toThrow(
      "open.required is required",
    );
    expect(() => describeOpening({ mode: { values: ["c"] } })).toThrow(
      "open.mode does not admit c",
    );
    expect(() => describeOpening({ mode: { callerPath: true } })).toThrow(
      "open.mode is not a path",
    );
  });
});

const delivering = each.filter(
  ([, description]) => description.evidenceDelivery,
);

describe("Evidence delivery of contract commands", () => {
  it.each(delivering)(
    "%s refuses summary delivery without --evidence_output before analysis",
    (_command, description) => {
      const refused = description.admit(
        argvValues(description, { detail: "summary" }),
      );
      expect(refused.ok).toBe(false);
      if (!refused.ok)
        expect(refused.error.issues.map(({ path }) => path)).toEqual([
          ["evidence_output"],
        ]);
      expect(
        description.admit(
          argvValues(description, {
            detail: "summary",
            evidence_output: "out.json",
          }),
        ).ok,
      ).toBe(true);
    },
  );

  it("refuses a union input whose branches differ outside the delivery", () => {
    const inputSchema = z.discriminatedUnion("detail", [
      z.object({
        detail: z.literal("complete").optional(),
        limit: z.number().optional(),
      }),
      z.object({
        detail: z.literal("summary"),
        limit: z.number().max(1).optional(),
      }),
    ]);
    expect(() =>
      describeContractCommand(
        { name: "probe", inputSchema },
        { command: "probe", description: "Probe", evidenceDelivery: true },
      ),
    ).toThrow("probe.limit differs between input branches");
    expect(() =>
      describeContractCommand(
        { name: "probe", inputSchema },
        { command: "probe", description: "Probe" },
      ),
    ).toThrow("probe.detail differs between input branches");
  });
});

const documents = contractDocumentCommandDescriptions(cli).map(
  (description) => [description.command, description] as const,
);

/** The JSON Schemas a property path can reach, through unions. */
const reachable = (
  schema: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown>[] => {
  // A typed schema keeps its own type; `allOf` there only adds constraints.
  const branches =
    schema.type !== undefined
      ? []
      : ["anyOf", "oneOf", "allOf"].flatMap((keyword) =>
          Array.isArray(schema[keyword])
            ? (schema[keyword] as Record<string, unknown>[])
            : [],
        );
  if (branches.length > 0)
    return branches.flatMap((branch) => reachable(branch, path));
  const [head, ...rest] = path;
  if (head === undefined) return [schema];
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const next = properties?.[head];
  return next === undefined ? [] : reachable(next, rest);
};

describe("JSON-document contract commands", () => {
  it("registers the migrated document commands", () => {
    expect(documents.map(([command]) => command)).toEqual(
      expect.arrayContaining([
        "compare-wasm-interfaces",
        "import-managed-reconstruction",
        "verify-managed-native-boundaries",
        "project-managed-application-graph",
        "trace-application-feature",
        "trace-javascript-semantics",
        "compare-application-versions",
        "compare-javascript-export-shapes",
        "project-android-application-graph",
        "project-apple-application-graph",
        "project-harmony-application-graph",
        "reconcile-javascript-runtime",
        "capture-electron-scenario",
        "compare-artifacts",
        "inspect-analysis-view",
        "match-native-functions",
        "build-reconstruction-obligation-ledger",
        "evaluate-reconstruction-coverage",
        "observe-native-calls",
        "compare-static-and-observed-endpoints",
        "capture-browser-scenario",
        "validate-browser-scenario",
      ]),
    );
  });

  it.each(documents)(
    "%s takes one JSON document whose --schema is its contract input",
    (_command, description) => {
      const command = registered.get(description.command)!;
      const args = (command.args as z.ZodObject).shape;
      expect(Object.keys(args)).toEqual([
        ...(description.sessionTarget === undefined
          ? []
          : [description.sessionTarget.key]),
        description.key,
      ]);
      const advertised = (args[description.key] as z.ZodType).meta();
      expect(advertised?.contentMediaType).toBe("application/json");
      const content = advertised?.contentSchema as Record<string, unknown>;
      expect(content).toEqual(jsonInputContentSchema(description.content));
      // Every contract field reaches the document unless omitted with a
      // reason or taken as an option beside it.
      const input = inputJsonSchema(description.contract.inputSchema);
      const fields = new Set(
        reachable(input, []).flatMap((branch) =>
          Object.keys(
            (branch.properties as Record<string, unknown> | undefined) ?? {},
          ),
        ),
      );
      for (const field of fields)
        expect(
          reachable(content, [field]).length > 0 ||
            Object.hasOwn(description.omitted, field) ||
            Object.hasOwn(description.flagged, field),
          field,
        ).toBe(true);
      for (const field of [
        ...Object.keys(description.omitted),
        ...Object.keys(description.flagged),
      ])
        expect(reachable(content, [field]), field).toEqual([]);
      const options = [
        ...description.deliveryOptions,
        ...description.cliOnlyOptions,
      ].map(({ key }) => key);
      for (const key of Object.values(description.flagged))
        expect(options, key).toContain(key);
      expect(
        Object.keys(
          (command.options as z.ZodObject | undefined)?.shape ?? {},
        ).toSorted(),
      ).toEqual(options.toSorted());
    },
  );

  it.each(documents.filter(([, { callerPaths }]) => callerPaths.length > 0))(
    "%s resolves only caller paths its contract declares as strings",
    (_command, description) => {
      const input = inputJsonSchema(description.contract.inputSchema);
      for (const path of description.callerPaths) {
        const targets = reachable(input, path);
        expect(targets.length, path.join(".")).toBeGreaterThan(0);
        for (const target of targets)
          expect(target.type, path.join(".")).toBe("string");
      }
    },
  );

  it("refuses omissions the document cannot make and options that shadow it", () => {
    const contract = {
      name: "probe",
      inputSchema: z.object({
        required: z.string(),
        optional: z.string().optional(),
      }),
    };
    const projection = {
      command: "probe",
      description: "Probe",
      document: "Probe JSON",
    };
    expect(() =>
      describeContractDocumentCommand(contract, {
        ...projection,
        omit: { required: "never" },
      }),
    ).toThrow("probe.required is not an optional field");
    expect(() =>
      describeContractDocumentCommand(
        {
          name: "probe",
          inputSchema: z.union([
            z.object({ a: z.string().optional() }),
            z.object({ b: z.string() }),
          ]),
        },
        { ...projection, omit: { a: "never" } },
      ),
    ).toThrow("probe omits fields from a union input");
    expect(() =>
      describeContractDocumentCommand(contract, {
        ...projection,
        cliOptions: { inputJson: z.string().optional() },
      }),
    ).toThrow("probe projects two fields to one CLI key");
    const described = describeContractDocumentCommand(contract, {
      ...projection,
      omit: { optional: "Not one-shot" },
    });
    expect(
      Object.keys(inputJsonSchema(described.content).properties as object),
    ).toEqual(["required"]);
  });
});

describe("JSON-document delivery options", () => {
  const contract = {
    name: "probe",
    inputSchema: z.object({
      required: z.string(),
      optional: z.string().optional(),
    }),
  };
  const projection = {
    command: "probe",
    description: "Probe",
    document: "Probe JSON",
  };

  it("takes detail and view beside the document and admits them before the handler", () => {
    expect(() =>
      describeContractDocumentCommand(contract, {
        ...projection,
        evidenceDelivery: true,
      }),
    ).toThrow("probe.detail is not an optional field");
    const delivered = {
      name: "probe",
      inputSchema: contract.inputSchema.extend({
        detail: z.enum(["complete", "summary"]).default("complete"),
        view: z.object({ offset: z.number() }).optional(),
      }),
    };
    expect(() =>
      describeContractDocumentCommand(delivered, {
        ...projection,
        viewDelivery: { invalidJson: "view must be JSON" },
      }),
    ).toThrow("probe view delivery requires evidenceDelivery");
    expect(() =>
      describeContractDocumentCommand(delivered, {
        ...projection,
        evidenceDelivery: true,
        omit: { detail: "never" },
      }),
    ).toThrow("probe.detail is both omitted and an option");
    expect(() =>
      describeContractDocumentCommand(delivered, {
        ...projection,
        evidenceDelivery: true,
        cliOptions: { evidence_output: z.string().optional() },
      }),
    ).toThrow("probe projects two fields to one CLI key");
    const flagged = describeContractDocumentCommand(delivered, {
      ...projection,
      evidenceDelivery: true,
      viewDelivery: { invalidJson: "view must be JSON" },
    });
    expect(
      Object.keys(inputJsonSchema(flagged.content).properties as object),
    ).toEqual(["required", "optional"]);
    expect(flagged.admitDelivery({ detail: "complete" })).toEqual({
      ok: true,
      value: { detail: "complete", evidenceOutput: undefined },
    });
    expect(
      flagged.admitDelivery({
        detail: "summary",
        evidence_output: "out.json",
        view: '{"offset":2}',
      }),
    ).toEqual({
      ok: true,
      value: {
        detail: "summary",
        evidenceOutput: "out.json",
        view: { offset: 2 },
      },
    });
    for (const values of [
      { detail: "complete", view: '{"offset":2}' },
      { detail: "summary", evidence_output: "out.json", view: "{" },
      {
        detail: "summary",
        evidence_output: "out.json",
        view: '{"offset":"2"}',
      },
      { detail: "summary" },
    ])
      expect(flagged.admitDelivery(values).ok, JSON.stringify(values)).toBe(
        false,
      );
  });
});

const selecting = each.flatMap(([command, description]) =>
  description.parameters.flatMap((parameter) =>
    parameter.selectorOption === undefined
      ? []
      : [[command, description, parameter, parameter.selectorOption] as const],
  ),
);

describe("Positional selectors with a named option", () => {
  it.each(selecting)(
    "%s takes its selector positionally or by its named option",
    (_command, description, parameter, option) => {
      const command = registered.get(description.command)!;
      const named = (command.options as z.ZodObject).shape[option.key];
      expect(admits(named as z.ZodType, undefined)).toBe(true);
      expect(admits(named as z.ZodType, "-dash")).toBe(true);
      // A required selector is refused when neither spelling is given,
      // including where only the CLI requires it.
      expect(option.required).toBe(
        option.required ||
          !admits(description.fields[parameter.field]!, undefined),
      );
      const { required } = option;
      const admit = (values: Record<string, unknown>) =>
        description.admit({
          [description.sessionTarget?.key ?? "path"]: "rel/app",
          ...values,
        });
      const selected = (values: Record<string, unknown>) => {
        const result = admit(values);
        return result.ok ? result.value.input[parameter.field] : result.error;
      };
      expect(selected({ [parameter.key]: "main" })).toBe("main");
      expect(selected({ [option.valueKey]: "-main" })).toBe("-main");
      expect(selected({ [parameter.key]: "m", [option.valueKey]: "m" })).toBe(
        "m",
      );
      const issues = (values: Record<string, unknown>) => {
        const result = admit(values);
        return result.ok ? [] : result.error.issues;
      };
      expect(issues({ [parameter.key]: "a", [option.valueKey]: "b" })).toEqual([
        expect.objectContaining({
          path: [option.key],
          reason: "invalid_value",
        }),
      ]);
      if (required)
        expect(issues({})).toEqual([
          expect.objectContaining({
            path: [option.key],
            reason: "missing_argument",
          }),
        ]);
      if (option.kind === "native")
        // The named spelling is kept when both name one native address.
        expect(
          selected({ [parameter.key]: "0x1a", [option.valueKey]: "0x1A" }),
        ).toBe("0x1A");
    },
  );

  const alternatives = selecting.flatMap(
    ([command, description, parameter, option]) =>
      option.alternative === undefined
        ? []
        : [[command, description, parameter, option.alternative] as const],
  );
  it.each(alternatives)(
    "%s maps its alternative selector option onto the same field",
    (_command, description, parameter, alternative) => {
      const option = parameter.selectorOption!;
      const admit = (values: Record<string, unknown>) =>
        description.admit({
          [description.sessionTarget?.key ?? "path"]: "rel/app",
          ...values,
        });
      const alone = admit({ [alternative.valueKey]: "0x10" });
      expect(alone.ok && alone.value.input[parameter.field]).toBe(
        alternative.selects("0x10"),
      );
      const agreeing = admit({
        [alternative.valueKey]: "0x10",
        [option.valueKey]: alternative.selects("0x10"),
      });
      expect(agreeing.ok).toBe(true);
      for (const conflicting of [
        { [alternative.valueKey]: "0x10", [parameter.key]: "main" },
        { [alternative.valueKey]: "0x10", [option.valueKey]: "main" },
      ]) {
        const result = admit(conflicting);
        expect(result.ok ? [] : result.error.issues).toEqual([
          expect.objectContaining({
            path: [alternative.key],
            reason: "invalid_value",
          }),
        ]);
      }
    },
  );

  it("refuses a selector whose contract admits an empty value", () => {
    expect(() =>
      describeContractCommand(
        { name: "probe", inputSchema: z.object({ text: z.string() }) },
        {
          command: "probe",
          description: "Probe",
          positionals: ["text"],
          selectorOptions: { text: { name: "text", description: "Text" } },
        },
      ),
    ).toThrow("probe.text admits an empty selector");
  });

  it("refuses a selector option on a field that is not a positional text selector", () => {
    const describeSelector = (
      positionals: readonly ("text" | "count")[],
      field: "text" | "count",
    ) =>
      describeContractCommand(
        {
          name: "probe",
          inputSchema: z.object({ text: z.string(), count: z.number() }),
        },
        {
          command: "probe",
          description: "Probe",
          positionals,
          selectorOptions: { [field]: { name: "named", description: "Named" } },
        },
      );
    expect(() => describeSelector([], "text")).toThrow(
      "probe.text is not a positional selector",
    );
    expect(() => describeSelector(["count"], "count")).toThrow(
      "probe.count is not a text selector",
    );
  });
});

describe("Operation choices selected by an option", () => {
  it("refuses an operation choice whose contract projects other options", () => {
    const projection = {
      command: "probe",
      description: "Probe",
      operationBy: {
        option: "kind",
        contracts: {
          other: {
            name: "other",
            inputSchema: z.object({ text: z.string(), extra: z.string() }),
          },
        },
      },
    };
    const base = describeContractCommand(
      { name: "probe", inputSchema: z.object({ text: z.string() }) },
      projection,
    );
    expect(() => describeOperationChoices(base, projection)).toThrow(
      "other does not project to probe's options",
    );
  });

  it("refuses an operation choice whose contract projects other option rules", () => {
    const projection = {
      command: "probe",
      description: "Probe",
      operationBy: {
        option: "kind",
        contracts: {
          other: {
            name: "other",
            inputSchema: z
              .object({ text: z.string(), limit: z.number().optional() })
              .meta({ dependentRequired: { limit: ["text"] } }),
          },
        },
      },
    };
    const base = describeContractCommand(
      {
        name: "probe",
        inputSchema: z.object({
          text: z.string(),
          limit: z.number().optional(),
        }),
      },
      projection,
    );
    expect(() => describeOperationChoices(base, projection)).toThrow(
      "other does not project to probe's options",
    );
  });
});
