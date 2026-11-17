import { cliCommand } from "../../../src/cli/commandRegistry.js";
import { createCommandCli } from "../../support/cli/commandCli.js";
import { z } from "zod";
import pino from "pino";
import { expect, it } from "vitest";

import { publishCliAnalysisEvidence } from "../../../src/cli/analysisEvidenceDelivery.js";
import {
  admittedContractInput,
  registerContractCommand,
  registerContractDocumentCommand,
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
  const cli = createCommandCli();
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
  const registered = cliCommand(cli, "probe")?.definition;
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
  const cli = createCommandCli();
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
  const registered = cliCommand(cli, "branch-probe")?.definition;
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
  const cli = createCommandCli();
  const received: unknown[] = [];
  // Counts evaluations of the whole contract schema; argv option parsing
  // checks field schemas only.
  let wholeParses = 0;
  const inputSchema = z
    .object({
      name: z.string(),
      limit: z.number().int().default(5),
    })
    .refine(
      ({ name }) => {
        wholeParses += 1;
        return name !== "blocked";
      },
      { message: "This name is reserved", path: ["name"] },
    );
  registerContractCommand(
    cli as unknown as CliInstance,
    pino({ enabled: false }),
    { name: "admitted_probe", inputSchema },
    { command: "admitted-probe", description: "Admitted probe" },
    async (_input, context) => {
      const admitted = admittedContractInput(context);
      // A second read reuses the first parse.
      expect(admittedContractInput(context)).toBe(admitted);
      received.push(admitted.ok ? admitted.value : "refused");
      return admitted.ok ? {} : { refused: admitted.error.issues.length };
    },
  );
  registerContractCommand(
    cli as unknown as CliInstance,
    pino({ enabled: false }),
    { name: "unread_probe", inputSchema },
    { command: "unread-probe", description: "Unread probe" },
    // Like inspectWithService, this handler leaves parsing to its service.
    async () => ({}),
  );
  const command = (name: string) => {
    const registered = cliCommand(cli, name)?.definition;
    if (registered === undefined) throw new Error(`${name} is missing`);
    const options = (value: unknown) =>
      (
        Reflect.get(registered, "options") as { parse(v: unknown): unknown }
      ).parse(value);
    const run = Reflect.get(registered, "run") as (
      value: unknown,
    ) => Promise<unknown>;
    return (value: unknown) => run({ args: {}, options: options(value) });
  };
  const admittedProbe = command("admitted-probe");
  const unreadProbe = command("unread-probe");
  const exitCode = process.exitCode;
  try {
    await admittedProbe({ name: "ok" });
    expect(wholeParses).toBe(1);
    // A contract rule over the whole input, checked after argv parsing,
    // reaches the handler as a refusal it reports in its own shape.
    await expect(admittedProbe({ name: "blocked" })).resolves.toEqual({
      refused: 1,
    });
    expect(wholeParses).toBe(2);
    // Admission does not parse for a handler that never reads the parse.
    await unreadProbe({ name: "ok" });
    expect(wholeParses).toBe(2);
  } finally {
    process.exitCode = exitCode;
  }
  // The parse applied the contract default the raw input did not carry.
  expect(received).toEqual([{ name: "ok", limit: 5 }, "refused"]);
});

it("hands a JSON-document handler the contract's parse of its document, once, only when read", async () => {
  const cli = createCommandCli();
  const received: unknown[] = [];
  let wholeParses = 0;
  const inputSchema = z
    .object({
      name: z.string(),
      limit: z.number().int().default(5),
    })
    .refine(
      ({ name }) => {
        wholeParses += 1;
        return name !== "blocked";
      },
      { message: "This name is reserved", path: ["name"] },
    );
  registerContractDocumentCommand(
    cli as unknown as CliInstance,
    pino({ enabled: false }),
    { name: "document_probe", inputSchema },
    {
      command: "document-probe",
      description: "Document probe",
      document: "Probe",
    },
    async (_document, context) => {
      const admitted = admittedContractInput(context);
      // A second read reuses the first parse.
      expect(admittedContractInput(context)).toBe(admitted);
      received.push(admitted.ok ? admitted.value : "refused");
      return admitted.ok ? {} : { refused: admitted.error.issues.length };
    },
  );
  registerContractDocumentCommand(
    cli as unknown as CliInstance,
    pino({ enabled: false }),
    { name: "unread_document_probe", inputSchema },
    {
      command: "unread-document-probe",
      description: "Unread document probe",
      document: "Probe",
    },
    // A handler whose document is not the whole input never parses it here.
    async () => ({}),
  );
  const command = (name: string) => {
    const registered = cliCommand(cli, name)?.definition;
    if (registered === undefined) throw new Error(`${name} is missing`);
    const args = (value: unknown) =>
      (Reflect.get(registered, "args") as { parse(v: unknown): unknown }).parse(
        value,
      );
    const run = Reflect.get(registered, "run") as (
      value: unknown,
    ) => Promise<unknown>;
    return (document: unknown) =>
      run({
        args: args({ inputJson: JSON.stringify(document) }),
        options: {},
      });
  };
  const documentProbe = command("document-probe");
  const unreadProbe = command("unread-document-probe");
  const exitCode = process.exitCode;
  try {
    await documentProbe({ name: "ok" });
    expect(wholeParses).toBe(1);
    await expect(documentProbe({ name: "blocked" })).resolves.toEqual({
      refused: 1,
    });
    expect(wholeParses).toBe(2);
    await unreadProbe({ name: "ok" });
    expect(wholeParses).toBe(2);
  } finally {
    process.exitCode = exitCode;
  }
  expect(received).toEqual([{ name: "ok", limit: 5 }, "refused"]);
});
