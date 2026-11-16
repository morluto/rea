import { Cli } from "incur";
import { expect, it } from "vitest";
import { z } from "zod";

import { registerContractCommand } from "../../../src/cli/contractCommand.js";
import type { CliInstance } from "../../../src/cli/types.js";
import { ok } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";

it("admits a checked JSON input through its check only, and the rest through the contract", async () => {
  let documentParses = 0;
  const contract = {
    name: "compare_checked_fixture",
    inputSchema: z.strictObject({
      // Registration probes the field with undefined; count document walks.
      document: z.custom<object>((value) => {
        if (value !== undefined) documentParses += 1;
        return true;
      }),
      max_age_ms: z.int().nonnegative().optional(),
    }),
  };
  const received: unknown[] = [];
  const cli = Cli.create("rea-checked-json-input", {
    version: "1",
    sync: false,
  });
  registerContractCommand(
    cli as unknown as CliInstance,
    silentLogger,
    contract,
    {
      command: "compare-checked-fixture",
      description: "Checked fixture",
      positionals: ["document"],
      jsonInputs: { document: "document must be JSON" },
      jsonInputChecks: {
        document: (value) => ok({ checked: value }),
      },
    },
    async (_input, { checked, parsed }) => {
      received.push({ checked, parsed });
      return {};
    },
  );
  const command = Cli.toCommands.get(cli)?.get("compare-checked-fixture");
  if (command === undefined) throw new Error("command is not registered");
  const parse = (key: "args" | "options", value: unknown) =>
    (Reflect.get(command, key) as { parse(v: unknown): unknown }).parse(value);
  const run = (options: unknown) =>
    (Reflect.get(command, "run") as (value: unknown) => Promise<unknown>)({
      args: parse("args", { document: '{"records":[1,2,3]}' }),
      options,
    });

  await run(parse("options", { maxAgeMs: 5 }));
  expect(documentParses).toBe(0);
  expect(received).toEqual([
    {
      checked: { document: { checked: { records: [1, 2, 3] } } },
      parsed: { document: { records: [1, 2, 3] }, max_age_ms: 5 },
    },
  ]);

  // The contract still admits the remaining fields, past argv parsing.
  expect(await run({ maxAgeMs: -1 })).toMatchObject({
    code: "invalid_request",
    details: { issues: [{ path: ["maxAgeMs"] }] },
  });
  expect(documentParses).toBe(0);
});
