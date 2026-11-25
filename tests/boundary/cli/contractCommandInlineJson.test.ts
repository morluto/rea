import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { registerContractCommand } from "../../../src/cli/contractCommand.js";
import {
  commandRoute,
  registerRoutedCommand,
} from "../../../src/cli/routedContractCommand.js";
import { cliCommand } from "../../../src/cli/commandRegistry.js";
import type { CliInstance } from "../../../src/cli/types.js";
import { createCommandCli } from "../../support/cli/commandCli.js";

describe.each(["direct", "routed"])("%s inline JSON admission", (kind) => {
  it.each([
    ['{"items":[1,2,3]}', { items: [1, 2, 3] }],
    ['"a JSON string"', "a JSON string"],
    ["null", null],
  ])(
    "decodes the inline option %s once per invocation",
    async (text, expected) => {
      const cli = createCommandCli();
      const received: unknown[] = [];
      const contract = {
        name: "inline_probe",
        inputSchema: z.object({ query: z.unknown() }),
      };
      const projection = {
        command: "inline-probe",
        description: "Inline JSON probe",
        runtimeJson: { query: "query must be JSON" },
      };
      const handle = async (input: unknown) => {
        received.push(input);
        return {};
      };
      if (kind === "direct")
        registerContractCommand(
          cli as unknown as CliInstance,
          pino({ enabled: false }),
          contract,
          projection,
          handle,
        );
      else
        registerRoutedCommand(
          cli as unknown as CliInstance,
          pino({ enabled: false }),
          projection,
          [
            commandRoute(contract, projection, handle, {
              requirement: "inline JSON",
            }),
          ],
        );
      const registered = cliCommand(cli, "inline-probe")?.definition;
      if (registered === undefined) throw new Error("inline-probe is missing");
      const parse = (value: unknown) => registered.options!.parse(value);
      const run = Reflect.get(registered, "run") as (
        value: unknown,
      ) => Promise<unknown>;
      const exitCode = process.exitCode;
      const parseJson = vi.spyOn(JSON, "parse");
      try {
        for (let invocation = 0; invocation < 2; invocation += 1) {
          parseJson.mockClear();
          await run({ args: {}, options: parse({ query: text }) });
          expect(received.at(-1)).toEqual({ query: expected });
          expect(
            parseJson.mock.calls.filter(([value]) => value === text),
          ).toHaveLength(1);
        }
        await expect(
          run({ args: {}, options: parse({ query: "{" }) }),
        ).resolves.toMatchObject({
          code: "invalid_request",
        });
        expect(received).toHaveLength(2);
      } finally {
        parseJson.mockRestore();
        process.exitCode = exitCode;
      }
    },
  );
});
