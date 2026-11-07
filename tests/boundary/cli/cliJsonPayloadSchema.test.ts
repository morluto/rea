import { Ajv2020 } from "ajv/dist/2020.js";
import { Cli, z } from "incur";
import { expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import { jsonInputArgument } from "../../../src/cli/jsonInputArgument.js";
import { createCliInventory } from "../../../scripts/lib/catalog-cli.mjs";
import { cliTest } from "../../support/cli/cliFixture.js";

const registeredCommands: WeakMap<
  object,
  NonNullable<ReturnType<typeof Cli.toCommands.get>>
> = Cli.toCommands;

const documentSchema = z
  .object({
    args: z
      .object({
        properties: z.record(
          z.string(),
          z
            .object({
              type: z.string(),
              contentMediaType: z.string().optional(),
              contentSchema: z.record(z.string(), z.unknown()).optional(),
            })
            .loose(),
        ),
      })
      .loose(),
  })
  .loose();

const advertisedSchema = async (
  cli: ReturnType<typeof Cli.create>,
  command: string,
) => {
  let stdout = "";
  await cli.serve([command, "--schema", "--json"], {
    env: {},
    stdout: (text) => {
      stdout += text;
    },
    exit: (code) => {
      expect(code).toBe(0);
    },
  });
  return documentSchema.parse(JSON.parse(stdout));
};

it("exposes decoded payload contracts for every whole-request JSON operand", async () => {
  const cli = createCli({});
  const commands = registeredCommands.get(cli);
  const selected: string[] = [];
  for (const command of createCliInventory(cli).primary) {
    const entry = commands?.get(command);
    if (entry === undefined || !("args" in entry)) continue;
    const args: unknown = entry.args;
    if (!(args instanceof z.ZodObject)) continue;
    const field =
      "inputJson" in args.shape
        ? "inputJson"
        : ["compare-wasm-interfaces", "match-native-functions"].includes(
              command,
            )
          ? "input"
          : undefined;
    if (field === undefined) continue;
    selected.push(command);
    const advertised = await advertisedSchema(cli, command);
    const operand = advertised.args.properties[field];
    expect(operand, command).toMatchObject({
      type: "string",
      contentMediaType: "application/json",
    });
    const payload = operand?.contentSchema;
    expect(payload, command).toBeDefined();
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    expect(ajv.validateSchema(payload ?? {}), command).toBe(true);
    const validate = ajv.compile(payload ?? {});
    expect(validate({}), command).toBe(false);
    // The argument remains a string: schemas describe decoded content, not a
    // replacement object operand, and filenames/stdin are still accepted.
    const validateArgs = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(advertised.args);
    for (const input of ["{}", "./request.json", "-"]) {
      const value = {
        [field]: input,
        ...(command === "observe-native-calls" ? { path: "./target" } : {}),
      };
      expect(validateArgs(value), command).toBe(true);
      expect(args.safeParse(value).success, command).toBe(true);
    }
  }
  expect(selected).toHaveLength(24);
});

it("advertises the CLI source-to-bundle contract and preserves optional defaults", async () => {
  const cli = createCli({});
  const source = await advertisedSchema(cli, "compare-source-to-bundle");
  const validate = new Ajv2020({
    strict: false,
    validateFormats: false,
  }).compile(source.args.properties.inputJson?.contentSchema ?? {});
  const request = {
    reference: { kind: "file", path: "./graph.json" },
    application: {
      kind: "retained-evidence",
      evidence_id: `ev_${"a".repeat(64)}`,
    },
  };
  expect(validate(request)).toBe(true);
  expect(validate({ ...request, reference: { kind: "file", path: "" } })).toBe(
    false,
  );
  expect(validate({ ...request, view: { kind: "summary" } })).toBe(false);
  const trace = await advertisedSchema(cli, "trace-application-feature");
  expect(trace.args.properties.inputJson?.contentSchema?.required).toEqual([
    "seed",
    "application",
  ]);
  const native = await advertisedSchema(cli, "observe-native-calls");
  const validateNative = new Ajv2020({
    strict: false,
    validateFormats: false,
  }).compile(native.args.properties.inputJson?.contentSchema ?? {});
  expect(
    validateNative({ breakpoints: [{ kind: "function", name: "main" }] }),
  ).toBe(true);
  expect(
    validateNative({ breakpoints: [{ kind: "invalid", name: "main" }] }),
  ).toBe(false);
  expect(validateNative({ breakpoints: [] })).toBe(false);
});

it("describes caller-relative payload paths without adding JSON content to ordinary operands", async () => {
  const cli = createCli({});
  for (const [command, request] of [
    [
      "inspect-analysis-view",
      {
        source: { kind: "evidence-file", path: "./evidence.json" },
        view: { kind: "summary" },
      },
    ],
    [
      "compare-artifacts",
      {
        left: { kind: "evidence-file", path: "./left.json" },
        right: { kind: "evidence-file", path: "./right.json" },
      },
    ],
    [
      "capture-electron-scenario",
      {
        executable_path: "./electron",
        application_path: "./app",
        application_root: "./root",
      },
    ],
  ] as const) {
    const schema = await advertisedSchema(cli, command);
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(schema.args.properties.inputJson?.contentSchema ?? {});
    expect(
      validate(request),
      `${command}: ${JSON.stringify(validate.errors)}`,
    ).toBe(true);
  }
  const ordinary = await advertisedSchema(cli, "inspect-wasm-artifact");
  expect(ordinary.args.properties.path).toMatchObject({ type: "string" });
  expect(ordinary.args.properties.path?.contentSchema).toBeUndefined();
});

it("keeps recursive payload references inside their own schema resource", async () => {
  const node = z.object({
    value: z.string().min(1),
    get children() {
      return z.array(node).optional();
    },
  });
  const cli = Cli.create("recursive-payload-test").command("tree", {
    args: z.object({ inputJson: jsonInputArgument("tree", node) }),
    run: ({ args }) => args,
  });
  const schema = await advertisedSchema(cli, "tree");
  const ajv = new Ajv2020({ strict: false });
  ajv.compile(schema.args);
  const validate = ajv.getSchema("urn:rea:cli:tree:input");
  expect(validate).toBeDefined();
  expect(validate?.({ value: "root", children: [{ value: "leaf" }] })).toBe(
    true,
  );
  expect(validate?.({ value: "root", children: [{ value: "" }] })).toBe(false);
});

cliTest(
  "compiled schema describes inputs accepted and refused by the offline validator",
  async ({ cli }) => {
    const schema = await cli.run({
      arguments: ["validate-browser-scenario", "--schema", "--json"],
    });
    expect(schema.exitCode, schema.stderr).toBe(0);
    const payload = documentSchema.parse(schema.json).args.properties.inputJson
      ?.contentSchema;
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(payload ?? {});
    const scenario = {
      browser: { mode: "launch", executable_path: "browser" },
      start_url: { url: "http://127.0.0.1:3000" },
      actions: [
        { step_id: "settle", action: "wait_for_timeout", duration_ms: 1 },
      ],
    };
    for (const actions of [scenario.actions, []]) {
      const request = { ...scenario, actions };
      const accepted = actions.length > 0;
      expect(validate(request)).toBe(accepted);
      const result = await cli.run({
        arguments: [
          "validate-browser-scenario",
          JSON.stringify(request),
          "--json",
        ],
      });
      expect(result.exitCode, result.stderr).toBe(accepted ? 0 : 1);
      if (accepted)
        expect(result.json).toEqual({ valid: true, actions: 1, secrets: 0 });
    }
  },
);
