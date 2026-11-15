import { Writable } from "node:stream";

import { Cli, Formatter } from "incur";
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
import {
  analysisParameterLimitSchema,
  analysisResultLimitSchema,
} from "../../../src/domain/analysisSettingDefinitions.js";
import { producerLimitControl } from "../../../src/domain/producerResourceLimits.js";
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
      producerLimitControl("output_bytes", 4, 8),
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
  // Captured content that looks like a control is data, not a reference
  // REA recorded, even when it names a bound flag.
  captured: {
    reported: deadlineParameterLimit("max_reply_bytes", 1, 2),
    nested: [{ limit: deadlineParameterLimit("max_reply_bytes", 1, 2) }],
  },
  // An omitted optional value that JSON output skips ends nothing.
  trailing: undefined,
});

/** The fixture's output schema: only its declared positions are controls. */
const partialResultSchema = z.strictObject({
  status: z.string(),
  unknowns: z.array(
    z.strictObject({
      dimension: z.string(),
      limit: analysisResultLimitSchema.exactOptional(),
    }),
  ),
  coverage: z.strictObject({
    limits: z.array(
      z.union([
        analysisParameterLimitSchema,
        z.strictObject({
          control_kind: z.literal("environment"),
          environment: z.string(),
          parameter: z.string(),
        }),
      ]),
    ),
  }),
  unbound: z.strictObject({ limit: analysisParameterLimitSchema }),
  captured: z.record(z.string(), z.unknown()),
  trailing: z.undefined().optional(),
});

const binding = {
  operation: "inspect_control_fixture",
  fields: {},
  flags: {
    worker_timeout_ms: "--worker-timeout-ms",
    producer_limits: "--producer-limits",
    max_reply_bytes: "--max-reply-bytes",
  },
};

it("collects each recorded control's flag without changing the result", () => {
  const result = partialResult();
  const before = structuredClone(result);
  expect(cliResultControlsIn(result, partialResultSchema, binding)).toEqual({
    worker_timeout_ms: "--worker-timeout-ms",
    "producer_limits.output_bytes": "--producer-limits",
  });
  expect(result).toEqual(before);
});

/** Run the fixture command once, returning its output and recorded controls. */
const runFixtureCommand = async (produce: () => unknown) => {
  const contract = {
    name: "inspect_control_fixture",
    inputSchema: z.strictObject({
      path: z.string(),
      worker_timeout_ms: z.number().int().optional(),
    }),
    outputSchema: partialResultSchema,
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
    async () => produce() as never,
  );
  const command = Cli.toCommands.get(cli)?.get("inspect-control-fixture");
  if (command === undefined) throw new Error("command is not registered");
  const parse = (key: "args" | "options", value: unknown) =>
    (Reflect.get(command, key) as { parse(v: unknown): unknown }).parse(value);
  return withCliResultControls(async () => {
    const value: unknown = await (
      Reflect.get(command, "run") as (value: unknown) => Promise<unknown>
    )({
      args: parse("args", { path: "fixture.bin" }),
      options: parse("options", {}),
    });
    return { output: value, controls: cliResultControls() };
  });
};

it("records the controls of a contract command's result and returns the result unchanged", async () => {
  const { output, controls } = await runFixtureCommand(partialResult);
  expect(output).toEqual(partialResult());
  // Only controls this command takes as options are rendered.
  expect(controls).toEqual({ worker_timeout_ms: "--worker-timeout-ms" });
});

it("reads a failure's partial Evidence of the same operation at the declared positions only", async () => {
  const failure = (operation: string) => ({
    code: "timeout",
    message: "Fixture stopped",
    details: {
      partial_observation: { ...partialResult(), operation },
    },
  });
  const same = await runFixtureCommand(() =>
    failure("inspect_control_fixture"),
  );
  expect(same.output).toEqual(failure("inspect_control_fixture"));
  expect(same.controls).toEqual({ worker_timeout_ms: "--worker-timeout-ms" });
  // Evidence of another operation is not described by this output schema.
  const other = await runFixtureCommand(() => failure("inspect_source_step"));
  expect(other.controls).toBeUndefined();
});

const written = async (
  argv: readonly string[],
  cliControls?: Readonly<Record<string, string>>,
): Promise<{ readonly text: string; readonly collected: number }> => {
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
  const format = argv[argv.indexOf("--format") + 1] ?? "json";
  let collected = 0;
  // The ordinary command path: no forced output, controls collected on demand.
  const handled = await output.write(partialResult(), {
    command: "fixture",
    duration: "0ms",
    format,
    collectCliControls: () => {
      collected += 1;
      return cliControls;
    },
  });
  return {
    text: handled ? Buffer.concat(chunks).toString("utf8") : "",
    collected,
  };
};

const cliControls = { worker_timeout_ms: "--worker-timeout-ms" };

it("renders the flags in the full-output envelope, outside the result", async () => {
  const full = await written(
    ["--format", "json", "--full-output"],
    cliControls,
  );
  expect(JSON.parse(full.text)).toEqual({
    ok: true,
    data: partialResult(),
    meta: {
      command: "fixture",
      duration: "0ms",
      cli_controls: cliControls,
    },
  });
  expect(full.collected).toBe(1);
  // The bare result is the record itself: it gains nothing, and the result
  // is not walked for controls nothing will show.
  const bare = await written(["--format", "json"], cliControls);
  expect(JSON.parse(bare.text)).toEqual(partialResult());
  expect(bare.collected).toBe(0);
  expect(
    JSON.parse((await written(["--format", "json", "--full-output"])).text),
  ).toEqual({
    ok: true,
    data: partialResult(),
    meta: { command: "fixture", duration: "0ms" },
  });
});

it.each(["yaml", "toon"] as const)(
  "keeps the requested %s format when the envelope shows the flags",
  async (format) => {
    const { text } = await written(
      ["--format", format, "--full-output"],
      cliControls,
    );
    expect(text).toBe(
      `${Formatter.format(
        {
          ok: true,
          data: partialResult(),
          meta: {
            command: "fixture",
            duration: "0ms",
            cli_controls: cliControls,
          },
        },
        format,
      )}\n`,
    );
  },
);
