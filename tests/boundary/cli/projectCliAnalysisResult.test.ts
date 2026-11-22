import { expect, it } from "vitest";

import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../../../src/domain/analysisErrorCleanup.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { freezeJsonSnapshot } from "../../../src/domain/immutableJson.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { createCli } from "../../../src/cli.js";
import { cliCommand, cliCommands } from "../../../src/cli/commandRegistry.js";
import { ArtifactOperationError } from "../../../src/domain/artifactOperationError.js";
import {
  projectCliCommandOutput,
  projectCliInputFields,
} from "../../../src/cli/projectCliAnalysisResult.js";

const binding = {
  operation: "inspect_keyed_archive",
  fields: { path: "archive" },
  flags: {},
};

it("projects bound input fields without changing canonical facts or nested paths", () => {
  const original = freezeJsonSnapshot(
    projectAnalysisError(
      new AnalysisInputError("inspect_keyed_archive", undefined, [
        {
          path: ["path", "path", 0],
          reason: "invalid_format",
          observed: { path: "verbatim source" },
        },
        { path: ["root"], reason: "invalid_value", expected: ["main"] },
      ]),
    ),
  );
  const mapped = projectCliInputFields(original, binding);
  expect(mapped).toEqual({
    ...original,
    details: {
      ...original.details,
      issues: [
        {
          path: ["archive", "path", 0],
          reason: "invalid_format",
          observed: { path: "verbatim source" },
        },
        { path: ["root"], reason: "invalid_value", expected: ["main"] },
      ],
    },
  });
  expect(original.details?.issues).toMatchObject([
    { path: ["path", "path", 0] },
    { path: ["root"] },
  ]);
});

it("keeps cleanup history and retained output while binding the actionable primary issue", () => {
  const primary = new AnalysisInputError(
    "inspect_keyed_archive",
    {
      capturedOutput: {
        stdout: "retained source output",
        stderr: "",
        truncated: false,
      },
    },
    [{ path: ["path"], reason: "invalid_value" }],
  );
  const cleanup = new ProviderCleanupError(
    "fixture",
    ["owned-input"],
    {},
    {
      cleanup: { reason: "close denied", resources: ["owned-input"] },
    },
  );
  const original = freezeJsonSnapshot(
    projectAnalysisError(analysisErrorWithCleanupFailure(primary, cleanup)),
  );
  expect(original.code).toBe("cleanup_incomplete");
  const mapped = projectCliInputFields(original, binding);
  expect(mapped).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      execution_failure: "invalid_request",
      issues: [{ path: ["archive"], reason: "invalid_value" }],
      diagnostics: {
        primary_error: { details: { issues: [{ path: ["path"] }] } },
      },
      captured_output: { stdout: "retained source output" },
    },
  });
  expect(mapped).toEqual({
    ...original,
    details: {
      ...original.details,
      issues: [{ path: ["archive"], reason: "invalid_value" }],
    },
  });
});

it("passes through successful data, unbound operations and unknown error values", () => {
  const value = { path: "caller-selected data" };
  expect(projectCliInputFields(value, binding)).toEqual(value);
  const targetError = projectAnalysisError(
    new AnalysisInputError("open_binary", undefined, [
      { path: ["path"], reason: "invalid_format" },
    ]),
  );
  expect(projectCliInputFields(targetError, binding)).toEqual(targetError);
  const unbound = projectAnalysisError(
    new AnalysisInputError("inspect_keyed_archive", undefined, [
      { path: ["root"], reason: "invalid_value" },
    ]),
  );
  expect(projectCliInputFields(unbound, binding)).toEqual(unbound);
  const unknown = {
    code: "future_failure",
    details: {
      operation: "inspect_keyed_archive",
      issues: [{ path: ["path"] }],
    },
  };
  expect(projectCliInputFields(unknown, binding)).toEqual(unknown);
});

it("renders related_cli_flags and related_cli_commands from the CLI command registry across command shapes", () => {
  const cli = createCli();
  const entries = cliCommands(cli);
  const inspectEntry = cliCommand(cli, "inspect");
  const compareEntry = cliCommand(cli, "compare");
  const inspectArtifactEntry = cliCommand(cli, "inspect-artifact");
  if (
    inspectEntry === undefined ||
    compareEntry === undefined ||
    inspectArtifactEntry === undefined
  )
    throw new Error("Expected registered CLI commands");

  // Artifact integrity errors omit details.operation when artifactDetails are present.
  const integrityFailure = projectAnalysisError(
    new ArtifactOperationError("inspect_artifact", "integrity", {
      logicalPath: "main.js",
      unpacked: false,
      declaredSha256: "a".repeat(64),
      calculatedSha256: "b".repeat(64),
    }),
  );
  expect(integrityFailure.details).toMatchObject({
    related_parameters: ["integrity_policy"],
  });
  expect(JSON.stringify(integrityFailure)).not.toContain("--integrity-policy");
  expect(
    projectCliCommandOutput(integrityFailure, {
      operations: inspectArtifactEntry.operations,
      commands: entries,
    }),
  ).toMatchObject({
    details: {
      related_cli_flags: { integrity_policy: "--integrity-policy" },
    },
  });

  // Operation references resolve canonical contract commands and aliased direct
  // commands while omitting MCP-only operations such as list_procedures and open_binary.
  const operationRefs = projectAnalysisError(
    new AnalysisInputError("procedure_pseudo_code", {
      related: {
        operations: [
          "analyze_function",
          "procedure_pseudo_code",
          "search_procedures",
          "inspect_plist",
          "inspect_wasm_artifact",
          "inspect_native_load_image",
          "analyze_javascript_application",
          "list_procedures",
          "open_binary",
        ],
      },
    }),
  );
  expect(
    projectCliCommandOutput(operationRefs, {
      operations: inspectEntry.operations,
      commands: entries,
    }),
  ).toMatchObject({
    details: {
      related_cli_commands: {
        analyze_function: "rea function",
        procedure_pseudo_code: "rea decompile",
        search_procedures: "rea search --kind procedures",
        inspect_plist: "rea inspect-plist",
        inspect_wasm_artifact: "rea inspect-wasm-artifact",
        inspect_native_load_image: "rea inspect-native-load-image",
        analyze_javascript_application: "rea analyze-javascript-application",
      },
    },
  });

  // Non-contract host commands that bind contract operations render flags too.
  const compareFailure = projectAnalysisError(
    new AnalysisInputError("compare_bundles", {
      related: { parameters: ["record_pairs"] },
    }),
  );
  expect(
    projectCliCommandOutput(
      { error: compareFailure },
      { operations: compareEntry.operations, commands: entries },
    ),
  ).toMatchObject({
    error: {
      details: { related_cli_flags: { record_pairs: "--record_pairs" } },
    },
  });
});

it("names a flattened member flag or the JSON flag for its containing group", () => {
  const cli = createCli();
  const commands = cliCommands(cli);
  const project = (command: string, limit: Record<string, string>) => {
    const entry = cliCommand(cli, command);
    if (entry === undefined) throw new Error(`Missing command ${command}`);
    return projectCliCommandOutput(
      { code: "resource_constraint", details: { limit } },
      { operations: entry.operations, commands },
    ).details.limit;
  };
  expect(
    project("inspect-web-network-capture", {
      control_kind: "parameter",
      parameter: "protobuf.schema.message_type",
    }),
  ).toEqual({
    control_kind: "parameter",
    parameter: "protobuf.schema.message_type",
    cli_flag: "--protobuf-message",
  });
  expect(
    project("inspect-binary-layout", {
      setting: "pwntools.max_input_bytes",
      parameter: "producer_limits.input_bytes",
    }),
  ).toEqual({
    setting: "pwntools.max_input_bytes",
    parameter: "producer_limits.input_bytes",
    cli_flag: "--producer-limits",
  });
  const unavailable = {
    control_kind: "parameter",
    parameter: "source_map_limits.fetch_bytes",
  };
  expect(project("trace-web-source-location", unavailable)).toEqual(
    unavailable,
  );

  const sourceLocation = cliCommand(cli, "trace-web-source-location");
  if (sourceLocation === undefined)
    throw new Error("Missing source location command");
  const data = {
    details: {
      limit: {
        control_kind: "parameter",
        parameter: "source_map_limits.decoded_records",
      },
    },
  };
  expect(
    projectCliCommandOutput(data, {
      operations: sourceLocation.operations,
      commands,
    }),
  ).toEqual(data);
});
