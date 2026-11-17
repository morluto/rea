import { cliCommand } from "../../../src/cli/commandRegistry.js";
import { createCommandCli } from "../../support/cli/commandCli.js";
import { expect, it } from "vitest";
import { z } from "zod";

import { registerContractCommand } from "../../../src/cli/contractCommand.js";
import { describeContractCommand } from "../../../src/cli/contractCliDescription.js";
import { projectCliInputFields } from "../../../src/cli/projectCliAnalysisResult.js";
import type { CliInstance } from "../../../src/cli/types.js";
import { AnalysisTimeoutError } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { nativeDeadlineRecovery } from "../../../src/domain/native/nativeDeadlines.js";
import { silentLogger } from "../../../src/logger.js";

const contract = {
  name: "inspect_control_fixture",
  inputSchema: z.strictObject({
    path: z.string(),
    worker_timeout_ms: z.number().int().optional(),
  }),
};

/** The failure a service reports: it names the contract field only. */
const deadlineFailure = () =>
  projectAnalysisError(
    new AnalysisTimeoutError(contract.name, 5, {
      ...nativeDeadlineRecovery({
        timeoutMs: 5,
        parameter: "worker_timeout_ms",
        defaultMs: 1_000,
        phase: "fixture deadline",
        unchanged: "",
      }),
    }),
  );

it("names the service's per-call control by field over MCP and by flag on the CLI", async () => {
  const mcp = deadlineFailure();
  expect(mcp.details?.limit).toMatchObject({
    control_kind: "parameter",
    parameter: "worker_timeout_ms",
  });
  expect(mcp.details?.limit).not.toHaveProperty("cli_flag");
  expect(JSON.stringify(mcp)).not.toContain("--");

  const cli = createCommandCli();
  registerContractCommand(
    cli as unknown as CliInstance,
    silentLogger,
    contract,
    {
      command: "inspect-control-fixture",
      description: "Control fixture",
      positionals: ["path"],
    },
    async () => deadlineFailure(),
  );
  const command = cliCommand(cli, "inspect-control-fixture")?.definition;
  if (command === undefined) throw new Error("command is not registered");
  const parse = (key: "args" | "options", value: unknown) =>
    (Reflect.get(command, key) as { parse(v: unknown): unknown }).parse(value);
  // A failed command sets the shared worker's exit status.
  const previousExitCode = process.exitCode;
  let output: ReturnType<typeof deadlineFailure>;
  try {
    output = (await (
      Reflect.get(command, "run") as (value: unknown) => Promise<unknown>
    )({
      args: parse("args", { path: "fixture.bin" }),
      options: parse("options", { workerTimeoutMs: 5 }),
    })) as ReturnType<typeof deadlineFailure>;
  } finally {
    process.exitCode = previousExitCode;
  }
  expect(output.details?.limit).toEqual({
    ...(mcp.details?.limit as object),
    cli_flag: "--worker-timeout-ms",
  });
  expect(output.remediation).toEqual(mcp.remediation);
});

it("names a member control by its member flag, else by its field's flag", () => {
  const failure = (parameter: string) => ({
    code: "provider_timeout",
    details: { limit: { control_kind: "parameter", parameter } },
  });
  const binding = {
    operation: "fixture",
    fields: {},
    flags: {
      producer_limits: "--producer-limits",
      "pool_policy.uri_limit": "--uri-limit",
    },
  };
  expect(
    projectCliInputFields(failure("producer_limits.output_bytes"), binding),
  ).toMatchObject({ details: { limit: { cli_flag: "--producer-limits" } } });
  expect(
    projectCliInputFields(failure("pool_policy.uri_limit"), binding),
  ).toMatchObject({ details: { limit: { cli_flag: "--uri-limit" } } });
  // A control the command does not take as a flag keeps the field only.
  const unbound = failure("analysis_timeout_ms");
  expect(projectCliInputFields(unbound, binding)).toBe(unbound);
  const success = { details: { limit: { parameter: "producer_limits" } } };
  expect(projectCliInputFields(success, binding)).toBe(success);
  // A registered setting that a request argument also selects names it.
  expect(
    projectCliInputFields(
      {
        code: "provider_timeout",
        details: {
          limit: {
            setting: "fixture.timeout_ms",
            parameter: "producer_limits.timeout_ms",
          },
        },
      },
      binding,
    ),
  ).toMatchObject({ details: { limit: { cli_flag: "--producer-limits" } } });
});

it("binds a nested flattened member to its own flag", () => {
  const description = describeContractCommand(
    {
      name: "inspect_nested_fixture",
      inputSchema: z.strictObject({
        path: z.string(),
        protobuf: z
          .strictObject({
            schema: z
              .strictObject({ message_type: z.string().optional() })
              .optional(),
          })
          .optional(),
      }),
    },
    {
      command: "inspect-nested-fixture",
      description: "Nested fixture",
      positionals: ["path"],
      flatten: {
        protobuf: {
          schema: {
            flatten: {
              message_type: {
                name: "protobufMessage",
                description: "Message type",
              },
            },
          },
        },
      },
    },
  );
  expect(description.inputBinding.flags).toEqual({
    "protobuf.schema.message_type": "--protobuf-message",
  });
  expect(
    projectCliInputFields(
      {
        code: "resource_limit_exceeded",
        details: {
          limit: {
            control_kind: "parameter",
            parameter: "protobuf.schema.message_type",
          },
        },
      },
      description.inputBinding,
    ),
  ).toMatchObject({ details: { limit: { cli_flag: "--protobuf-message" } } });
});
