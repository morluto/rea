import { parseCliArgv } from "../../../src/cli/argvParser.js";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import {
  contractNamed,
  describeContractCommand,
  describeOperationChoices,
  describeContractDocumentCommand,
  type ContractCliDescription,
  type ContractCliParameter,
} from "../../../src/cli/contractCliDescription.js";
import { BROWSER_TOOL_CONTRACTS } from "../../../src/contracts/browserToolContracts.js";
import { passiveNetworkCapture } from "../../fixtures/passiveNetworkCapture.js";
import { contractInputBranch } from "../../../src/cli/contractCommand.js";
import { jsonInputContentSchema } from "../../../src/cli/jsonInputArgument.js";
import {
  cliCommands,
  type CliCommandEntry,
} from "../../../src/cli/commandRegistry.js";
import { absoluteCallerPath } from "../../../src/filesystem/callerPath.js";
import { presentRootDiscriminator } from "../../../src/domain/schemaAnnotations.js";
import {
  TOOL_CONTRACTS,
  toolContract,
} from "../../../src/contracts/toolContracts.js";
import { registeredContractDescriptions } from "../../support/cli/commandCli.js";

/** Apply the same inline-option admission stage as registered commands. */
const admitOptions = (
  description: ContractCliDescription,
  values: Readonly<Record<string, unknown>>,
): ReturnType<ContractCliDescription["admit"]> => {
  const options = description.admitDeliveryOptions(values);
  return options.ok ? description.admit(options.value) : options;
};
const DECIMAL_TOKEN = /^[0-9]+$/u;

const cli = createCli({});
const registered = new Map<string, CliCommandEntry["definition"]>();
cliCommands(cli).forEach(({ definition: command, name: path }) => {
  registered.set(path, command);
});
const { commands: descriptions, documents: documentDescriptions } =
  registeredContractDescriptions(cli);

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
  // An omitted option takes its CLI default, which the contract admits.
  if (parameter.cliDefault !== undefined && value === undefined) return true;
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

/**
 * Contract fields the handler supplies: each Evidence target's from its
 * source, and each handler field from CLI-only values.
 */
const handlerSuppliedFields = (
  description: ContractCliDescription,
): string[] => [
  ...(description.evidenceTargets?.targets ?? []).map(({ field }) => field),
  ...description.handlerFields,
];

/**
 * The contract schema one parameter supplies: a field, a flattened member,
 * or a field group's optional object of its fields.
 */
const suppliedField = (
  description: ContractCliDescription,
  parameter: ContractCliParameter,
): z.ZodType => {
  const shape = contractShape(description);
  if (parameter.group !== undefined)
    return z
      .strictObject(
        Object.fromEntries(
          parameter.group.map((field) => [field, shape[field]!]),
        ),
      )
      .optional();
  const field = shape[parameter.field]!;
  if (parameter.member === undefined) return field;
  // A member is omittable when it or any enclosing object is.
  let supplied: z.ZodType = field;
  let omittable = false;
  for (const member of parameter.member) {
    omittable ||= admits(supplied, undefined);
    while (
      supplied instanceof z.ZodOptional ||
      supplied instanceof z.ZodExactOptional
    )
      supplied = supplied.unwrap() as z.ZodType;
    supplied = (supplied as z.ZodObject).shape[member] as z.ZodType;
  }
  return omittable ? supplied.optional() : supplied;
};

/**
 * Argv takes a transformed field's inbound text, as tools/list advertises
 * it; the contract transforms it on admission. CLI help may word the field
 * differently, and the contract applies its own default.
 */
const expectInboundView = (
  key: string,
  cliField: z.ZodType,
  contractField: z.ZodType,
): void => {
  const inbound = (schema: z.ZodType) => {
    const {
      default: _default,
      description: _description,
      ...view
    } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
    return view;
  };
  expect(inbound(cliField), key).toEqual(inbound(contractField));
  expect(admits(cliField, undefined), key).toBe(
    admits(contractField, undefined),
  );
};

/** Each positional caller path is resolved, and kept as typed in callerInputs. */
const expectResolvedPositionalPaths = (
  description: ContractCliDescription,
  values: Readonly<Record<string, unknown>>,
  input: Readonly<Record<string, unknown>>,
): void => {
  for (const parameter of description.parameters) {
    if (!parameter.callerPath || !parameter.positional) continue;
    // A flattened member is resolved inside its object.
    const path = [parameter.field, ...(parameter.member ?? [])];
    const resolved = path.reduce<unknown>(
      (value, key) => (value as Record<string, unknown>)[key],
      input,
    );
    expect(resolved).toBe(absoluteCallerPath("rel/target"));
    expect(description.callerInputs(values)[path.join(".")]).toBe("rel/target");
  }
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

const processComparisonExample = toolContract("compare_process_captures")
  .examples[0]!.input as { readonly left: unknown; readonly right: unknown };
const screenshotExample = toolContract("compare_web_screenshots").examples[0]!
  .input as { readonly before: unknown; readonly after: unknown };

const captureDiff = contractNamed(
  BROWSER_TOOL_CONTRACTS,
  "compare_web_captures",
);
const scenarioExample = captureDiff.examples[0]!.input as {
  readonly before_scenario: unknown;
  readonly after_scenario: unknown;
};

/**
 * Argv for each input shape of a command routed by document content, keyed
 * by the shape its route projects; a passive capture and a scenario capture
 * cannot both satisfy one fixture.
 */
const ROUTE_ARGV: ReadonlyMap<
  unknown,
  Readonly<Record<string, unknown>>
> = new Map<unknown, Readonly<Record<string, unknown>>>([
  [
    contractInputBranch(captureDiff, "before").inputSchema,
    {
      beforeJson: JSON.stringify({ inspection: passiveNetworkCapture() }),
      afterJson: JSON.stringify({ inspection: passiveNetworkCapture() }),
    },
  ],
  [
    contractInputBranch(captureDiff, "before_scenario").inputSchema,
    {
      beforeJson: JSON.stringify(scenarioExample.before_scenario),
      afterJson: JSON.stringify(scenarioExample.after_scenario),
    },
  ],
]);

/**
 * Argv for commands whose contract rules need more than one value per
 * required field: a selector choice, a pattern grammar or a change to make.
 */
const ARGV_SATISFYING_RULES: Readonly<
  Record<string, Readonly<Record<string, unknown>>>
> = {
  "annotate-native-function": { name: "renamed" },
  "search-bytes": { pattern: "41 ??" },
  "cutter-command": { sessionId: "00000000-0000-4000-8000-000000000001" },
  "inspect-native-data-type": { type: "/struct" },
  "capture-native-ui-scenario": {
    steps: '[{"kind":"wait","milliseconds":0}]',
  },
  // The handler selects the local device when the caller selects none.
  "list-frida-processes": { deviceId: "local" },
  // The contract transforms the endpoint text it admits.
  "list-browser-targets": { endpoint: "http://127.0.0.1:9222" },
  "observe-web-session": { endpoint: "http://127.0.0.1:9222" },
  "inspect-web-page": { endpoint: "http://127.0.0.1:9222" },
  "list-electron-targets": { endpoint: "http://127.0.0.1:9222" },
  "inspect-electron-page": { endpoint: "http://127.0.0.1:9222" },
  "discover-webmcp-tools": { endpoint: "http://127.0.0.1:9222" },
  "capture-web-screenshot": { endpoint: "http://127.0.0.1:9222" },
  "observe-web-execution": { endpoint: "http://127.0.0.1:9222" },
  "inspect-web-event-listeners": { endpoint: "http://127.0.0.1:9222" },
  "analyze-web-bundle": { endpoint: "http://127.0.0.1:9222" },
  "list-javascript-runtime-targets": { endpoint: "http://127.0.0.1:9229" },
  "observe-javascript-runtime": { endpoint: "http://127.0.0.1:9229" },
  // Each side must be a self-verifying screenshot artifact.
  "compare-web-screenshots": {
    beforeJson: JSON.stringify(screenshotExample.before),
    afterJson: JSON.stringify(screenshotExample.after),
  },
  // Each side must be process capture Evidence.
  "compare-process-captures": {
    left: JSON.stringify(processComparisonExample.left),
    right: JSON.stringify(processComparisonExample.right),
  },
};

const each = descriptions.map(
  (description) => [description.command, description] as const,
);

/** Every command the contract builders registered, from their registry. */
const contractBuilt: ReadonlySet<string> = new Set(
  [...descriptions, ...documentDescriptions].map(({ command }) => command),
);

/** Contract-built commands whose name differs from their contract's. */
const RENAMED_CONTRACT_COMMANDS = [
  "analyze",
  "decompile",
  "function",
  "inspect",
  "instructions",
  "list-objdump-architectures",
  "search",
  "trace",
  "validate-browser-scenario",
];

const commandName = (contract: string): string => contract.replaceAll("_", "-");

// Derived from the registries, so a command that stops registering through a
// contract builder fails here rather than silently leaving the parity cases.
it("builds every contract-named command from its contract", () => {
  const named = new Set(TOOL_CONTRACTS.map(({ name }) => commandName(name)));
  expect(
    [...named]
      .filter((name) => registered.has(name) && !contractBuilt.has(name))
      .toSorted(),
  ).toEqual([]);
  expect(
    [...contractBuilt].filter((name) => !named.has(name)).toSorted(),
  ).toEqual(RENAMED_CONTRACT_COMMANDS);
});

// The CLI resolves a relative caller path against the working directory, so
// its help must not inherit an MCP description that requires an absolute one.
it("describes every caller path without requiring an absolute path", () => {
  expect(
    descriptions.flatMap(({ command, parameters }) =>
      parameters
        .filter(
          ({ callerPath, description }) =>
            callerPath && /\babsolute\b/iu.test(description ?? ""),
        )
        .map(({ key }) => `${command} ${key}`),
    ),
  ).toEqual([]);
});

// An argv fixture names a contract-built command, so it cannot outlive its registration.
it("keeps every argv fixture on a contract-built command", () => {
  expect(
    Object.keys(ARGV_SATISFYING_RULES).filter(
      (name) => !contractBuilt.has(name),
    ),
  ).toEqual([]);
});

const commandsWithBooleanFlags = each.filter(([, { parameters }]) =>
  parameters.some(({ positional, booleanFlag }) => !positional && booleanFlag),
);
describe("CLI commands projected from tool contracts", () => {
  it.each(each)(
    "%s exposes every contract field or declares its omission",
    (_command, description) => {
      expect(
        [
          ...new Set(
            description.parameters.flatMap(
              ({ field, group }) => group ?? [field],
            ),
          ),
          ...Object.keys(description.omitted),
          ...Object.keys(description.fixedFields),
          ...handlerSuppliedFields(description),
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
        ...(description.evidenceTargets?.targets ?? []).map(({ key }) => key),
        ...description.parameters
          .filter(({ positional }) => positional)
          .map(({ key }) => key),
        ...description.cliPositionals.map(({ key }) => key),
      ]);
      // A routed command takes the union of its routes' options.
      const routes = descriptions.filter(
        ({ command: name }) => name === description.command,
      );
      expect(optionKeys.toSorted()).toEqual(
        [
          ...new Set(
            routes.flatMap((route) => [
              ...route.parameters
                .filter(({ positional }) => !positional)
                .map(({ key }) => key),
              ...(route.sessionTarget?.options ?? []).map(({ key }) => key),
              ...(route.evidenceTargets?.options ?? []).map(({ key }) => key),
              ...route.cliOnlyOptions.map(({ key }) => key),
              ...route.parameters.flatMap(({ selectorOption }) =>
                [selectorOption, selectorOption?.alternative].flatMap(
                  (option) => (option === undefined ? [] : [option.key]),
                ),
              ),
            ]),
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
        if (parameter.inbound) {
          expectInboundView(parameter.key, cliField, contractField);
          continue;
        }
        if (parameter.runtimeJson !== undefined) {
          // JSON text decoded when the command runs; see below. Argv
          // requires the text of a required field.
          expect(admits(cliField, undefined), parameter.key).toBe(
            admits(contractField, undefined),
          );
          for (const value of ["{", "{}"])
            expect(admits(cliField, value), parameter.key).toBe(true);
          // Empty text is neither JSON nor a JSON input's file path.
          expect(admits(cliField, ""), parameter.key).toBe(
            !parameter.jsonInput,
          );
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

  it.each(commandsWithBooleanFlags)(
    "%s takes each boolean contract field as a bare flag",
    (_command, description) => {
      for (const parameter of description.parameters) {
        if (parameter.positional || !parameter.booleanFlag) continue;
        const options = z.object({
          [parameter.key]: registeredField(description, parameter),
        });
        const flag = `--${parameter.key.replaceAll(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)}`;
        expect(parseCliArgv([flag], { options }), flag).toMatchObject({
          ok: true,
          value: { options: { [parameter.key]: true } },
        });
      }
    },
  );

  it.each(each)(
    "%s maps parsed argv to an admitted contract input",
    (command, description) => {
      const values = argvValues(
        description,
        ROUTE_ARGV.get(description.contract.inputSchema) ??
          ARGV_SATISFYING_RULES[command] ??
          {},
      );
      // Runtime JSON text is decoded as admission does.
      for (const { key, runtimeJson } of description.parameters)
        if (runtimeJson !== undefined && typeof values[key] === "string")
          values[key] = JSON.parse(values[key]) as unknown;
      const input = description.toContractInput(values);
      const targets = new Set(handlerSuppliedFields(description));
      const admitted =
        targets.size === 0
          ? description.contract.inputSchema
          : z.object(
              Object.fromEntries(
                Object.entries(contractShape(description)).filter(
                  ([field]) => !targets.has(field),
                ),
              ),
            );
      expect(admitted.safeParse(input).error).toBe(undefined);
      expectResolvedPositionalPaths(description, values, input);
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
    ["an array of booleans", z.array(z.boolean()).optional()],
    ["a tuple", z.tuple([z.string()]).optional()],
  ])("refuses to describe a field that is %s", (_kind, field) => {
    expect(() =>
      describeContractCommand(
        { name: "probe", inputSchema: z.object({ field }) },
        { command: "probe", description: "Probe" },
      ),
    ).toThrow("probe.field has no argv projection");
  });

  it("takes an array of numbers as repeated decimal tokens within its bounds", () => {
    const [parameter] = describeContractCommand(
      {
        name: "probe",
        inputSchema: z.object({
          ordinals: z.array(z.int().nonnegative()).min(1).max(2).optional(),
        }),
      },
      { command: "probe", description: "Probe" },
    ).parameters;
    const schema = parameter!.schema;
    expect(parameter!.repeatable).toBe(true);
    expect(schema.parse(["0", "7"])).toEqual([0, 7]);
    expect(schema.parse(undefined)).toBeUndefined();
    for (const refused of [["0x1"], ["-1"], [], ["1", "2", "3"]])
      expect(schema.safeParse(refused).success, String(refused)).toBe(false);
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

  it("takes CLI-only positionals after the contract's and leaves handler fields to the handler", () => {
    const contract = {
      name: "probe",
      inputSchema: z.object({
        mode: z.enum(["a", "b"]),
        id: z.number().optional(),
        kind: z.enum(["x", "y"]),
        value: z.string().optional(),
      }),
    };
    const described = describeContractCommand(contract, {
      command: "probe",
      description: "Probe",
      positionals: ["mode"],
      cliOptions: { target: z.string().min(1) },
      cliPositionals: ["target"],
      handlerFields: ["id", "kind"],
    });
    expect(described.parameters.map(({ field }) => field)).toEqual([
      "mode",
      "value",
    ]);
    expect(described.cliPositionals.map(({ key }) => key)).toEqual(["target"]);
    expect(described.cliOnlyOptions).toEqual([]);
    expect(described.handlerFields).toEqual(["id", "kind"]);
    expect(
      described.toContractInput({ mode: "a", target: "7", value: "v" }),
    ).toEqual({ mode: "a", value: "v" });
    expect(described.cliOptionValues({ mode: "a", target: "7" })).toEqual({
      target: "7",
    });
    expect(() =>
      describeContractCommand(contract, {
        command: "probe",
        description: "Probe",
        cliPositionals: ["missing" as never],
      }),
    ).toThrow("probe has no CLI option missing");
    expect(() =>
      describeContractCommand(contract, {
        command: "probe",
        description: "Probe",
        handlerFields: ["kind"],
        fields: { kind: { name: "k" } },
      }),
    ).toThrow("probe.kind is filled by the handler");
    expect(() =>
      describeContractCommand(contract, {
        command: "probe",
        description: "Probe",
        handlerFields: ["absent" as never],
      }),
    ).toThrow("probe has no input field absent");
  });

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
        // The command reads a JSON input before admission and refuses it
        // there; the CLI tests cover that refusal.
        if (parameter.runtimeJson === undefined || parameter.jsonInput)
          continue;
        const malformed = admitOptions(
          description,
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
            // The command hands admission a JSON input already decoded.
            if (parameter.jsonInput)
              values[parameter.key] = JSON.parse(text) as unknown;
            const decoded = JSON.parse(text) as unknown;
            const { group } = parameter;
            // A field group supplies the members of a JSON object, each one
            // of its fields; other JSON is refused before the contract.
            const supplied =
              group === undefined
                ? { [parameter.field]: decoded }
                : typeof decoded === "object" &&
                    decoded !== null &&
                    !Array.isArray(decoded) &&
                    Object.keys(decoded).every((key) => group.includes(key))
                  ? decoded
                  : undefined;
            const expected =
              supplied !== undefined &&
              description.contract.inputSchema.safeParse({
                ...description.toContractInput({
                  ...values,
                  [parameter.key]: undefined,
                }),
                ...(detail === undefined ? {} : { detail }),
                ...supplied,
              }).success;
            const admitted = admitOptions(description, values).ok;
            // A checked JSON input is admitted by its check, which the
            // command runs as soon as the input is read, and may be
            // stricter than the contract; the contract admits the rest.
            const check = parameter.checkJsonInput?.(decoded);
            const refusedByCheck = check !== undefined && !check.ok;
            if (expected ? !admitted : admitted && !refusedByCheck)
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
    "%s supplies the object with only the given members",
    (_command, description) => {
      // A required object is always supplied, so only optional ones apply.
      const fields = new Set(
        description.parameters.flatMap(({ field, member }) =>
          member === undefined ||
          !contractShape(description)[field]!.safeParse(undefined).success
            ? []
            : [field],
        ),
      );
      for (const field of fields) {
        const members = description.parameters.filter(
          (parameter) =>
            parameter.field === field && parameter.member !== undefined,
        );
        expect(
          field in description.toContractInput(argvValues(description, {})),
        ).toBe(false);
        for (const given of members) {
          const value = requiredValue(description, given);
          const input = description.toContractInput(
            argvValues(description, { [given.key]: value }),
          );
          // An omitted member stays omitted, never an explicit undefined;
          // a nested member supplies each enclosing object with only itself.
          let object = input[field] as Record<string, unknown>;
          for (const member of given.member!.slice(0, -1)) {
            expect(Object.keys(object)).toEqual([member]);
            object = object[member] as Record<string, unknown>;
          }
          expect(Object.keys(object)).toEqual([given.member!.at(-1)]);
          expect(object[given.member!.at(-1)!]).toEqual(
            given.callerPath ? absoluteCallerPath(value as string) : value,
          );
        }
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
    ).toThrow("probe.value is not an object");
  });

  it("takes a required object's members as positionals in member order", () => {
    const inputSchema = z.strictObject({
      name: z.string(),
      position: z.strictObject({ line: z.int(), column: z.int() }),
      limits: z.strictObject({ bytes: z.int().optional() }).optional(),
    });
    const described = describeContractCommand(
      { name: "probe", inputSchema },
      {
        command: "probe",
        description: "Probe",
        positionals: ["name", "position"],
        flatten: {
          position: { line: {}, column: { name: "col" } },
          limits: { bytes: {} },
        },
      },
    );
    expect(
      described.parameters.map(({ key, positional }) => [key, positional]),
    ).toEqual([
      ["name", true],
      ["line", true],
      ["col", true],
      ["bytes", false],
    ]);
    const [, line] = described.parameters;
    expect(line!.schema.safeParse(undefined).success).toBe(false);
    expect(line!.schema.safeParse("2").success).toBe(true);
    expect(described.toContractInput({ name: "n", line: 2, col: 0 })).toEqual({
      name: "n",
      position: { line: 2, column: 0 },
    });
    expect(() =>
      describeContractCommand(
        { name: "probe", inputSchema },
        {
          command: "probe",
          description: "Probe",
          positionals: ["limits"],
          flatten: { limits: { bytes: {} } },
        },
      ),
    ).toThrow("probe.limits is an optional positional object");
    expect(() =>
      describeContractCommand(
        {
          name: "probe",
          inputSchema: z.strictObject({
            position: z.strictObject({ line: z.int().optional() }),
          }),
        },
        {
          command: "probe",
          description: "Probe",
          positionals: ["position"],
          flatten: { position: { line: {} } },
        },
      ),
    ).toThrow("probe.position.line is an optional positional");
    // Omitting every member would drop a required object argv cannot spell.
    expect(() =>
      describeContractCommand(
        {
          name: "probe",
          inputSchema: z.strictObject({
            limits: z.strictObject({ bytes: z.int().optional() }),
          }),
        },
        {
          command: "probe",
          description: "Probe",
          flatten: { limits: { bytes: {} } },
        },
      ),
    ).toThrow("probe.limits has no required member");
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
      // A selector field is named by its own option, which selection
      // issues already use; its positional may share another key.
      for (const {
        field,
        key,
        member,
        selectorOption,
      } of description.parameters)
        if (member === undefined) {
          const named = selectorOption?.key ?? key;
          expect(description.inputBinding.fields[field]).toBe(
            named === field ? undefined : named,
          );
        }
    },
  );

  it("refuses a root discriminator the projection neither delivers, omits nor selects", () => {
    const mode = z.string();
    const inputSchema = presentRootDiscriminator(
      z.union([z.strictObject({ mode }), z.strictObject({ mode })]),
      "mode",
    );
    expect(() =>
      describeContractCommand(
        // A root union of objects, as delivery-discriminated contracts are.
        { name: "probe", inputSchema } as never,
        {
          command: "probe",
          description: "Probe",
        },
      ),
    ).toThrow("probe root discriminator mode has no CLI projection");
  });

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

/** Summary selections for contracts whose summary requires a view. */
const SUMMARY_SELECTIONS: Readonly<
  Record<string, Readonly<Record<string, unknown>>>
> = {
  "analyze-web-bundle": {
    view: '{"kind":"web-bundle","collection":"endpoints"}',
  },
};

const delivering = each.filter(
  ([, description]) => description.evidenceDelivery,
);

describe("Evidence delivery of contract commands", () => {
  it.each(delivering)(
    "%s refuses summary delivery without --evidence_output before analysis",
    (command, description) => {
      const satisfying = {
        ...ARGV_SATISFYING_RULES[command],
        ...SUMMARY_SELECTIONS[command],
      };
      const refused = admitOptions(
        description,
        argvValues(description, { ...satisfying, detail: "summary" }),
      );
      expect(refused.ok).toBe(false);
      if (!refused.ok)
        expect(refused.error.issues.map(({ path }) => path)).toEqual([
          ["evidence_output"],
        ]);
      expect(
        admitOptions(
          description,
          argvValues(description, {
            ...satisfying,
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
    ).toThrow("probe.limit differs between input branches");
  });

  it("selects an input branch with a literal in one branch and an enum in another", () => {
    const inputSchema = z.union([
      z.strictObject({ format: z.literal("json").default("json") }),
      z.strictObject({ format: z.enum(["sdl", "graphql"]) }),
    ]);
    const [format] = describeContractCommand(
      { name: "probe", inputSchema },
      { command: "probe", description: "Probe" },
    ).parameters;
    expect(format!.schema.parse(undefined)).toBeUndefined();
    expect(inputJsonSchema(format!.schema).default).toBe("json");
    expect(inputSchema.parse({})).toEqual({ format: "json" });
    expect(format!.schema.safeParse("graphql").success).toBe(true);
    expect(format!.schema.safeParse("xml").success).toBe(false);
  });

  it("takes the input branches a command selects and fixes a single selected value", () => {
    const path = z.string();
    const inputSchema = z.discriminatedUnion("operation", [
      z.strictObject({ operation: z.enum(["a", "b"]), path }),
      z.strictObject({
        operation: z.literal("c"),
        path,
        symbol: z.string().optional(),
      }),
      z.strictObject({ operation: z.literal("d") }),
    ]);
    const describe = (values: readonly [string, ...string[]]) =>
      describeContractCommand(
        { name: "probe", inputSchema },
        {
          command: "probe",
          description: "Probe",
          inputBranches: { field: "operation", values },
        },
      );
    const artifact = describe(["a", "b", "c"]);
    expect(artifact.parameters.map(({ key }) => key)).toEqual([
      "operation",
      "path",
      "symbol",
    ]);
    const operation = artifact.parameters[0]!.schema;
    expect(operation.safeParse("c").success).toBe(true);
    expect(operation.safeParse("d").success).toBe(false);
    expect(artifact.parameters[1]!.schema.safeParse(undefined).success).toBe(
      false,
    );
    const fixed = describe(["d"]);
    expect(fixed.parameters).toEqual([]);
    expect(fixed.toContractInput({})).toEqual({ operation: "d" });
    expect(inputSchema.safeParse(fixed.toContractInput({})).success).toBe(true);
    expect(() => describe(["a"])).toThrow(
      "probe.operation would narrow an input branch",
    );
    expect(() => describe(["e"])).toThrow(
      "probe.operation selects no branch for a value",
    );
    expect(() =>
      describeContractCommand(
        { name: "probe", inputSchema: z.object({ operation: z.string() }) },
        {
          command: "probe",
          description: "Probe",
          inputBranches: { field: "operation", values: ["a"] },
        },
      ),
    ).toThrow("probe has one input branch");
  });
});

const documents = documentDescriptions.map(
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

it.each([
  [
    "checked optional",
    z
      .string()
      .optional()
      .refine((value) => value !== undefined),
    true,
  ],
  ["invalid prefault", z.string().min(2).prefault("x"), false],
] as const)(
  "projects document omission using object parsing for %s",
  (_kind, field, acceptsOmission) => {
    const inputSchema = z.object({ detail: field });
    expect(inputSchema.safeParse({}).success).toBe(acceptsOmission);
    const describe = () =>
      describeContractDocumentCommand(
        { name: "probe", inputSchema },
        {
          command: "probe",
          description: "Probe",
          document: "Probe JSON",
          omit: { detail: "never" },
        },
      );
    if (acceptsOmission) expect(describe).not.toThrow();
    else expect(describe).toThrow("probe.detail is not an optional field");
  },
);

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

describe("Selector agreement in registered commands", () => {
  const xrefs = descriptions.find(({ command }) => command === "xrefs")!;

  it.each([
    ["ram%2f:0X0001A", "ram%2F:0x1a"],
    ["0x20000000000001", "0x020000000000001"],
  ])("preserves the named address when %s and %s agree", (left, right) => {
    const result = xrefs.admit({
      [xrefs.sessionTarget!.key]: "rel/app",
      address: left,
      "--address": right,
    });
    expect(result.ok && result.value.input.address).toBe(right);
  });

  it.each([
    ["0x1", "ram:0x1"],
    ["0x20000000000000", "0x20000000000001"],
    ["0xinvalid", "0XINVALID"],
  ])(
    "refuses different or unrecognized coordinates %s and %s",
    (left, right) => {
      const result = xrefs.admit({
        [xrefs.sessionTarget!.key]: "rel/app",
        address: left,
        "--address": right,
      });
      expect(result.ok ? [] : result.error.issues).toEqual([
        expect.objectContaining({ path: ["address"], reason: "invalid_value" }),
      ]);
    },
  );
});

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
        admitOptions(description, {
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
        admitOptions(description, {
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

describe("Contract command field groups", () => {
  const contract = {
    name: "group_probe",
    inputSchema: z.strictObject({
      path: z.string(),
      name: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
  };
  const grouped = (
    fields: readonly [
      "name" | "tags" | "path",
      ...("name" | "tags" | "path")[],
    ],
  ) =>
    describeContractCommand(contract, {
      command: "group-probe",
      description: "Probe",
      positionals: ["path"],
      fieldGroups: {
        query: {
          fields,
          description: "JSON selection",
          invalidJson: "query must be a JSON selection object.",
        },
      },
    });

  it("supplies each member of one JSON object option as its contract field", () => {
    const description = grouped(["name", "tags"]);
    expect(description.parameters.map(({ key }) => key)).toEqual([
      "path",
      "query",
    ]);
    const admitted = admitOptions(description, {
      path: "/x",
      query: '{"name":"a","tags":["b"]}',
    });
    expect(admitted.ok && admitted.value.input).toEqual({
      path: "/x",
      name: "a",
      tags: ["b"],
    });
    expect(admitOptions(description, { path: "/x" }).ok).toBe(true);
  });

  it.each([
    ["[]", ["query"], "invalid_format"],
    ['{"path":"/y"}', ["query", "path"], undefined],
    ['{"name":1}', ["name"], undefined],
  ])("refuses the group %s", (text, path, reason) => {
    const admitted = admitOptions(grouped(["name", "tags"]), {
      path: "/x",
      query: text,
    });
    expect(admitted.ok).toBe(false);
    if (admitted.ok) return;
    expect(admitted.error.issues[0]).toMatchObject({
      path,
      ...(reason === undefined ? {} : { reason }),
    });
  });

  it("refuses a group member an object rule names", () => {
    expect(() =>
      describeContractCommand(
        {
          name: "group_probe",
          inputSchema: contract.inputSchema.meta({
            dependentRequired: { name: ["tags"] },
          }),
        },
        {
          command: "group-probe",
          description: "Probe",
          positionals: ["path"],
          fieldGroups: {
            query: {
              fields: ["name", "tags"],
              description: "x",
              invalidJson: "x",
            },
          },
        },
      ),
    ).toThrow("group_probe.name is grouped but named by an input rule");
  });

  it("refuses a required or twice-projected group member", () => {
    expect(() => grouped(["path"])).toThrow(
      "group_probe.path is projected twice",
    );
    expect(() =>
      describeContractCommand(contract, {
        command: "group-probe",
        description: "Probe",
        fieldGroups: {
          query: { fields: ["path"], description: "x", invalidJson: "x" },
        },
      }),
    ).toThrow("group_probe.path is a required group member");
  });
});
