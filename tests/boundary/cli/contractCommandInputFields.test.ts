import { Cli, z } from "incur";
import pino from "pino";
import { expect, it } from "vitest";

import { publishCliAnalysisEvidence } from "../../../src/cli/analysisEvidenceDelivery.js";
import { registerContractCommand } from "../../../src/cli/contractCommand.js";
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
  return (address: string) =>
    execute({
      args: parse("args", { address }),
      options: parse("options", {}),
    });
};

it("names a delivered provider failure's input field by its CLI key", async () => {
  const invoke = harness();
  await expect(invoke("missing")).resolves.toMatchObject({
    code: "invalid_request",
    details: {
      operation: "lookup_probe",
      issues: [{ path: ["address"], reason: "invalid_value" }],
    },
  });
});
