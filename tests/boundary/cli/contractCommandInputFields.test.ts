import { Cli, z } from "incur";
import pino from "pino";
import { expect, it } from "vitest";

import { publishCliAnalysisEvidence } from "../../../src/cli/analysisEvidenceDelivery.js";
import {
  admittedContractInput,
  registerContractCommand,
} from "../../../src/cli/contractCommand.js";
import type { CliInstance } from "../../../src/cli/types.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";

/** A provider lookup failure as an operation reports it, by contract field. */
const lookupFailure = {
  error: "Procedure not found",
  code: "invalid_request",
  details: {
    operation: "lookup_probe",
    issues: [{ path: ["procedure"], reason: "invalid_value" }],
  },
} as const satisfies JsonValue;

/**
 * One synthetic contract whose `procedure` field the CLI spells `address`,
 * returning the provider's failure through the shared Evidence delivery.
 */
const harness = () => {
  const cli = Cli.create("rea-input-fields-test", {
    version: "1",
    sync: false,
  });
  registerContractCommand(
    cli as unknown as CliInstance,
    pino({ enabled: false }),
    {
      name: "lookup_probe",
      inputSchema: z.object({
        procedure: z.string(),
        detail: z.enum(["complete", "summary"]).default("complete"),
      }),
    },
    {
      command: "probe",
      description: "Probe",
      positionals: ["procedure"],
      evidenceDelivery: true,
      fields: { procedure: { name: "address", description: "Procedure" } },
    },
    async (_input, { operation, signal, delivery }) =>
      publishCliAnalysisEvidence(
        { ok: false, error: lookupFailure },
        {
          operation,
          signal,
          detail: delivery?.detail ?? "complete",
          evidenceOutput: delivery?.evidenceOutput,
        },
      ),
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
  // A failed command sets the shared worker's exit status; restore it.
  return async (address: string) => {
    const exitCode = process.exitCode;
    try {
      return await execute({
        args: parse("args", { address }),
        options: parse("options", {}),
      });
    } finally {
      process.exitCode = exitCode;
    }
  };
};

it("names a delivered provider failure's input field by its CLI key", async () => {
  const invoke = harness();
  const exitCode = process.exitCode;
  await expect(invoke("missing")).resolves.toMatchObject({
    code: "invalid_request",
    details: {
      operation: "lookup_probe",
      issues: [{ path: ["address"], reason: "invalid_value" }],
    },
  });
  expect(process.exitCode).toBe(exitCode);
});

it("keeps a branch-only default out of the branch the caller selects", async () => {
  const cli = Cli.create("rea-branch-default-test", {
    version: "1",
    sync: false,
  });
  const received: unknown[] = [];
  registerContractCommand(
    cli as unknown as CliInstance,
    pino({ enabled: false }),
    {
      name: "branch_probe",
      inputSchema: z.discriminatedUnion("action", [
        z.strictObject({ action: z.literal("list") }),
        z.strictObject({
          action: z.literal("render"),
          limit: z.number().int().default(10),
        }),
      ]),
    },
    {
      command: "branch-probe",
      description: "Branch probe",
      fields: { action: { default: "list" } },
    },
    async (input) => {
      received.push(input);
      return {};
    },
  );
  const registered = Cli.toCommands.get(cli)?.get("branch-probe");
  if (registered === undefined) throw new Error("branch-probe is missing");
  const parse = (value: unknown) =>
    (
      Reflect.get(registered, "options") as { parse(v: unknown): unknown }
    ).parse(value);
  const execute = Reflect.get(registered, "run") as (
    value: unknown,
  ) => Promise<unknown>;
  for (const options of [{}, { action: "render" }])
    await execute({ args: {}, options: parse(options) });
  // The selected branch applies its own default when it parses the input.
  expect(received).toEqual([{ action: "list" }, { action: "render" }]);
});

it("hands a whole-input handler the contract's parse, or its refusal, without parsing again", async () => {
  const cli = Cli.create("rea-admitted-input-test", {
    version: "1",
    sync: false,
  });
  const received: unknown[] = [];
  registerContractCommand(
    cli as unknown as CliInstance,
    pino({ enabled: false }),
    {
      name: "admitted_probe",
      inputSchema: z
        .object({
          name: z.string(),
          limit: z.number().int().default(5),
        })
        .refine(({ name }) => name !== "blocked", {
          message: "This name is reserved",
          path: ["name"],
        }),
    },
    { command: "admitted-probe", description: "Admitted probe" },
    async (_input, context) => {
      const admitted = admittedContractInput(context);
      received.push(admitted.ok ? admitted.value : "refused");
      return admitted.ok ? {} : { refused: admitted.error.issues.length };
    },
  );
  const registered = Cli.toCommands.get(cli)?.get("admitted-probe");
  if (registered === undefined) throw new Error("admitted-probe is missing");
  const options = (value: unknown) =>
    (
      Reflect.get(registered, "options") as { parse(v: unknown): unknown }
    ).parse(value);
  const execute = Reflect.get(registered, "run") as (
    value: unknown,
  ) => Promise<unknown>;
  const exitCode = process.exitCode;
  try {
    await execute({ args: {}, options: options({ name: "ok" }) });
    // A contract rule over the whole input, checked after argv parsing,
    // reaches the handler as a refusal it reports in its own shape.
    await expect(
      execute({ args: {}, options: options({ name: "blocked" }) }),
    ).resolves.toEqual({ refused: 1 });
  } finally {
    process.exitCode = exitCode;
  }
  // The parse applied the contract default the raw input did not carry.
  expect(received).toEqual([{ name: "ok", limit: 5 }, "refused"]);
});
