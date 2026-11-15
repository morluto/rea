import { Cli, z } from "incur";
import pino from "pino";
import { expect, it } from "vitest";

import {
  registerTargetRoutedCommand,
  targetRoute,
} from "../../../src/cli/contractCommand.js";
import type { CliInstance } from "../../../src/cli/types.js";
import { absoluteLocalPathStringSchema } from "../../../src/domain/localPath.js";

/** Two synthetic contracts routed by whether the target names an archive. */
const harness = () => {
  const calls: { route: string; cliOptions: unknown; input: unknown }[] = [];
  const cli = Cli.create("rea-routed-test", { version: "1", sync: false });
  const command = { command: "probe", description: "Probe" };
  registerTargetRoutedCommand(
    cli as unknown as CliInstance,
    pino({ enabled: false }),
    command,
    [
      targetRoute(
        {
          name: "archive_probe",
          inputSchema: z.object({
            input_path: absoluteLocalPathStringSchema,
            mode: z.enum(["fast", "full"]).default("fast"),
          }),
        },
        {
          ...command,
          positionals: ["input_path"],
          callerPaths: ["input_path"],
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
          takesTarget: async (target) => target.endsWith(".asar"),
          requirement: "an archive target",
        },
      ),
      targetRoute(
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
  const registered = Cli.toCommands.get(cli)?.get("probe");
  if (registered === undefined) throw new Error("probe was not registered");
  const execute = Reflect.get(registered, "run") as (
    value: unknown,
  ) => Promise<unknown>;
  const parse = (key: "args" | "options", value: unknown) =>
    (Reflect.get(registered, key) as { parse(v: unknown): unknown }).parse(
      value,
    );
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
  return { calls, invoke };
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
            "--report requires an archive target; this target runs program_probe, which does not take it.",
        },
      ],
    },
  });
});
