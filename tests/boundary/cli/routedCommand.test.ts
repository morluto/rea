import { cliCommand } from "../../../src/cli/commandRegistry.js";
import { createCommandCli } from "../../support/cli/commandCli.js";
import { z } from "zod";
import pino from "pino";
import { expect, it } from "vitest";

import {
  registerRoutedCommand,
  commandRoute,
} from "../../../src/cli/routedContractCommand.js";
import type { CliInstance } from "../../../src/cli/types.js";
import { absoluteLocalPathStringSchema } from "../../../src/domain/localPath.js";

/** Two synthetic contracts routed by whether the target names an archive. */
const harness = () => {
  const calls: { route: string; cliOptions: unknown; input: unknown }[] = [];
  const cli = createCommandCli();
  const command = { command: "probe", description: "Probe" };
  registerRoutedCommand(
    cli as unknown as CliInstance,
    pino({ enabled: false }),
    command,
    [
      commandRoute(
        {
          name: "archive_probe",
          inputSchema: z.object({
            input_path: absoluteLocalPathStringSchema,
            mode: z.enum(["fast", "full"]).default("fast"),
            policy: z
              .object({ rules: z.array(z.string()) })
              .default({ rules: [] }),
          }),
        },
        {
          ...command,
          positionals: ["input_path"],
          callerPaths: ["input_path"],
          jsonInputs: { policy: "policy must be JSON" },
          fields: { input_path: { name: "path", description: "Target" } },
          cliOptions: {
            report: z.enum(["text", "json"]).default("text"),
          },
        },
        async (input, { cliOptions }) => {
          calls.push({ route: "archive", cliOptions, input });
          return {};
        },
        {
          takes: async ({ path }) => String(path).endsWith(".asar"),
          requirement: "an archive target",
        },
      ),
      commandRoute(
        { name: "program_probe", inputSchema: z.object({}) },
        { ...command, sessionTarget: { description: "Target" } },
        async (input, { cliOptions }) => {
          calls.push({ route: "program", cliOptions, input });
          return {};
        },
        { requirement: "a program target" },
      ),
    ],
  );
  const registered = cliCommand(cli, "probe")?.definition;
  if (registered === undefined) throw new Error("probe was not registered");
  const execute = Reflect.get(registered, "run") as (
    value: unknown,
  ) => Promise<unknown>;
  const parse = (key: "args" | "options", value: unknown) =>
    registered[key]!.parse(value);
  // A refused command sets the shared worker's exit status; restore it.
  const invoke = async (
    path: string,
    options: Record<string, unknown> = {},
  ) => {
    const exitCode = process.exitCode;
    try {
      return await execute({
        args: parse("args", { path }),
        options: parse("options", options),
      });
    } finally {
      process.exitCode = exitCode;
    }
  };
  const options = registered.options!;
  return { calls, invoke, options };
};

it("gives the chosen route its CLI-only defaults after routing without them", async () => {
  const { calls, invoke } = harness();
  await invoke("/x/app.asar");
  await invoke("/x/program");
  expect(calls).toEqual([
    {
      route: "archive",
      cliOptions: { report: "text" },
      input: { input_path: "/x/app.asar" },
    },
    { route: "program", cliOptions: {}, input: {} },
  ]);
});

it("refuses an option the chosen route does not own by its CLI key", async () => {
  const { calls, invoke } = harness();
  const refused = await invoke("/x/program", { report: "json" });
  expect(calls).toEqual([]);
  expect(refused).toMatchObject({
    code: "invalid_request",
    details: {
      operation: "program_probe",
      issues: [
        {
          path: ["report"],
          message:
            "--report requires an archive target; the given input selects a program target, which does not take it.",
        },
      ],
    },
  });
});

it("advertises each option's default without supplying it to routing", async () => {
  const { calls, invoke, options } = harness();
  const schema = z.toJSONSchema(options) as {
    readonly properties: Readonly<Record<string, unknown>>;
  };
  expect(schema.properties).toMatchObject({
    mode: {
      default: "fast",
    },
    policy: { default: JSON.stringify({ rules: [] }) },
    report: { default: "text" },
  });
  expect(schema.properties.mode).not.toHaveProperty("description");
  // A given option routes the input even when it spells the default.
  const refused = await invoke("/x/program", { report: "text" });
  expect(calls).toEqual([]);
  expect(refused).toMatchObject({
    code: "invalid_request",
    details: { issues: [{ path: ["report"] }] },
  });
});

it("refuses routes that check a shared JSON input differently", () => {
  const cli = createCommandCli();
  const command = { command: "probe", description: "Probe" };
  const route = (name: string, check: () => { ok: true; value: string }) =>
    commandRoute(
      {
        name,
        inputSchema: z.object({ policy: z.object({}).optional() }),
      },
      {
        ...command,
        jsonInputs: { policy: "policy must be JSON" },
        jsonInputChecks: { policy: check },
      },
      async () => ({}),
      { takes: async () => true, requirement: name },
    );
  expect(() =>
    registerRoutedCommand(
      cli as unknown as CliInstance,
      pino({ enabled: false }),
      command,
      [
        route("first_probe", () => ({ ok: true, value: "first" })),
        route("second_probe", () => ({ ok: true, value: "second" })),
      ],
    ),
  ).toThrow("probe routes check --policy differently");
});

it("accepts structurally matching shared options and rejects differing constraints or metadata", () => {
  const cli = createCommandCli();
  const command = { command: "probe", description: "Probe" };
  const route = (name: string, extra: z.ZodType) =>
    commandRoute(
      {
        name,
        inputSchema: z.object({
          path: absoluteLocalPathStringSchema,
          flag: z.boolean().optional(),
          mode: z.enum(["a", "b"]).optional(),
          extra,
        }),
      },
      {
        ...command,
        positionals: ["path"],
      },
      async () => ({}),
      { takes: async () => true, requirement: name },
    );
  expect(() =>
    registerRoutedCommand(
      cli as unknown as CliInstance,
      pino({ enabled: false }),
      command,
      [
        route("one_probe", z.string().optional()),
        route("two_probe", z.string().optional()),
      ],
    ),
  ).not.toThrow();

  expect(() =>
    registerRoutedCommand(
      createCommandCli() as unknown as CliInstance,
      pino({ enabled: false }),
      command,
      [
        route("one_probe", z.string().optional()),
        route("two_probe", z.string().min(2).optional()),
      ],
    ),
  ).toThrow("probe routes disagree on --extra");

  expect(() =>
    registerRoutedCommand(
      createCommandCli() as unknown as CliInstance,
      pino({ enabled: false }),
      command,
      [
        route("one_probe", z.string().describe("first").optional()),
        route("two_probe", z.string().describe("second").optional()),
      ],
    ),
  ).toThrow("probe routes disagree on --extra");
});
