import { Writable } from "node:stream";

import { Cli } from "incur";
import { expect, it } from "vitest";
import { z } from "zod";

import { parseCliOutputArguments } from "../../../src/cliOutput.js";
import { registerContractCommand } from "../../../src/cli/contractCommand.js";
import { createCliResultOutput } from "../../../src/cli/cliResultOutput.js";
import {
  cliResultControls,
  withCliResultControls,
} from "../../../src/cli/cliResultControls.js";
import { cliResultControlsIn } from "../../../src/cli/projectCliAnalysisResult.js";
import type { CliInstance } from "../../../src/cli/types.js";
import { deadlineParameterLimit } from "../../../src/domain/analysisResourceLimits.js";
import { silentLogger } from "../../../src/logger.js";

/** A partial result that records its controls by contract field only. */
const partialResult = () => ({
  status: "partial",
  unknowns: [
    {
      dimension: "javascript_analysis",
      limit: deadlineParameterLimit("worker_timeout_ms", 5, 1_000),
    },
  ],
  coverage: {
    limits: [
      {
        setting: "fixture.output_bytes",
        parameter: "producer_limits.output_bytes",
      },
      // An environment control has no per-call option.
      {
        control_kind: "environment",
        environment: "REA_FIXTURE_BYTES",
        parameter: "ignored",
      },
    ],
  },
  // A control this command takes no flag for keeps only its field.
  unbound: { limit: deadlineParameterLimit("other_timeout_ms", 1, 2) },
});

const binding = {
  operation: "inspect_control_fixture",
  fields: {},
  flags: {
    worker_timeout_ms: "--worker-timeout-ms",
    producer_limits: "--producer-limits",
  },
};

it("collects each recorded control's flag without changing the result", () => {
  const result = partialResult();
  const before = structuredClone(result);
  expect(cliResultControlsIn(result, binding)).toEqual({
    worker_timeout_ms: "--worker-timeout-ms",
    "producer_limits.output_bytes": "--producer-limits",
  });
  expect(result).toEqual(before);
});

it("records the controls of a contract command's result and returns the result unchanged", async () => {
  const contract = {
    name: "inspect_control_fixture",
    inputSchema: z.strictObject({
      path: z.string(),
      worker_timeout_ms: z.number().int().optional(),
    }),
  };
  const cli = Cli.create("rea-result-controls", { version: "1", sync: false });
  registerContractCommand(
    cli as unknown as CliInstance,
    silentLogger,
    contract,
    {
      command: "inspect-control-fixture",
      description: "Control fixture",
      positionals: ["path"],
    },
    async () => partialResult(),
  );
  const command = Cli.toCommands.get(cli)?.get("inspect-control-fixture");
  if (command === undefined) throw new Error("command is not registered");
  const parse = (key: "args" | "options", value: unknown) =>
    (Reflect.get(command, key) as { parse(v: unknown): unknown }).parse(value);
  const { output, controls } = await withCliResultControls(async () => {
    const value: unknown = await (
      Reflect.get(command, "run") as (value: unknown) => Promise<unknown>
    )({
      args: parse("args", { path: "fixture.bin" }),
      options: parse("options", {}),
    });
    return { output: value, controls: cliResultControls() };
  });
  expect(output).toEqual(partialResult());
  // Only controls this command takes as options are rendered.
  expect(controls).toEqual({ worker_timeout_ms: "--worker-timeout-ms" });
});

const written = async (
  argv: readonly string[],
  cliControls?: Readonly<Record<string, string>>,
): Promise<unknown> => {
  const chunks: Buffer[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  const output = createCliResultOutput(
    parseCliOutputArguments(["fixture", ...argv]),
    destination,
  );
  if (output === undefined) throw new Error("Missing output surface");
  expect(
    await output.write(partialResult(), {
      command: "fixture",
      duration: "0ms",
      format: argv.includes("yaml") ? "yaml" : "json",
      forceOutput: true,
      ...(cliControls === undefined ? {} : { cliControls }),
    }),
  ).toBe(true);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

it("renders the flags in the full-output envelope, outside the result", async () => {
  const cliControls = { worker_timeout_ms: "--worker-timeout-ms" };
  expect(
    await written(["--format", "json", "--full-output"], cliControls),
  ).toEqual({
    ok: true,
    data: partialResult(),
    meta: {
      command: "fixture",
      duration: "0ms",
      cli_controls: cliControls,
    },
  });
  // The bare result is the record itself, so it gains nothing.
  expect(await written(["--format", "json"], cliControls)).toEqual(
    partialResult(),
  );
  expect(await written(["--format", "json", "--full-output"])).toEqual({
    ok: true,
    data: partialResult(),
    meta: { command: "fixture", duration: "0ms" },
  });
});
