import { expect, it } from "vitest";

import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
  reattributedResourceConstraint,
} from "../../../src/domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../../../src/domain/analysisErrorCleanup.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { freezeJsonSnapshot } from "../../../src/domain/immutableJson.js";
import { ownedJsonObjectSchema } from "../../../src/domain/jsonValue.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err, ok } from "../../../src/domain/result.js";
import { createCli } from "../../../src/cli.js";
import { cliCommand, cliCommands } from "../../../src/cli/commandRegistry.js";
import { BinaryTargetError } from "../../../src/domain/configurationErrors.js";
import { ArtifactOperationError } from "../../../src/domain/artifactOperationError.js";
import {
  projectCliAnalysisResult,
  projectCliCommandOutput,
  projectCliInputFields,
} from "../../../src/cli/projectCliAnalysisResult.js";

const binding = {
  operation: "inspect_keyed_archive",
  fields: { path: "archive" },
  flags: {},
};

it("projects bound input fields without changing canonical facts or nested identities", () => {
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
  const details = ownedJsonObjectSchema.parse(
    ownedJsonObjectSchema.parse(mapped).details,
  );
  const mappedIssues = details.issues;
  const originalIssues = original.details?.issues;
  if (!Array.isArray(mappedIssues) || !Array.isArray(originalIssues))
    throw new Error("Expected projected input issues");
  expect(mappedIssues[1]).toBe(originalIssues[1]);
  expect(ownedJsonObjectSchema.parse(mappedIssues[0]).observed).toBe(
    ownedJsonObjectSchema.parse(originalIssues[0]).observed,
  );
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
  const details = ownedJsonObjectSchema.parse(
    ownedJsonObjectSchema.parse(mapped).details,
  );
  expect(details.diagnostics).toBe(original.details?.diagnostics);
  expect(details.captured_output).toBe(original.details?.captured_output);
});

it("passes through successful data, unbound operations and unknown error values", () => {
  const value = { path: "caller-selected data" };
  expect(projectCliInputFields(value, binding)).toBe(value);
  const targetError = projectAnalysisError(
    new AnalysisInputError("open_binary", undefined, [
      { path: ["path"], reason: "invalid_format" },
    ]),
  );
  expect(projectCliInputFields(targetError, binding)).toBe(targetError);
  const unbound = projectAnalysisError(
    new AnalysisInputError("inspect_keyed_archive", undefined, [
      { path: ["root"], reason: "invalid_value" },
    ]),
  );
  expect(projectCliInputFields(unbound, binding)).toBe(unbound);
  expect(projectCliAnalysisResult(err(targetError))).toBe(targetError);
  expect(projectCliAnalysisResult(ok(value))).toBe(value);
  const unknown = {
    code: "future_failure",
    details: {
      operation: "inspect_keyed_archive",
      issues: [{ path: ["path"] }],
    },
  };
  expect(projectCliInputFields(unknown, binding)).toBe(unknown);
});

it("names related fields and operations by contract identity and renders only this command's flags", () => {
  const constraint = new AnalysisResourceConstraintError(
    "inspect_sqlite_database",
    "memory",
    "fixture limit",
    null,
    {
      related: {
        parameters: ["columns", "table", "row_limit"],
        operations: ["inspect_artifact"],
      },
    },
  );
  // Re-attribution keeps the inputs the recovery names, as it keeps `limit`.
  const projected = projectAnalysisError(
    reattributedResourceConstraint("inspect_sqlite_database", constraint),
  );
  expect(projected.details).toMatchObject({
    related_parameters: ["columns", "table", "row_limit"],
    related_operations: ["inspect_artifact"],
  });
  const sqlite = {
    operation: "inspect_sqlite_database",
    fields: {},
    flags: { columns: "--column", table: "--table" },
  };
  // A field the command takes no flag for is left to the contract name.
  expect(projectCliInputFields(projected, sqlite)).toMatchObject({
    details: { related_cli_flags: { columns: "--column", table: "--table" } },
  });
  // Another command's failure keeps its fields for that command to render.
  expect(
    projectCliInputFields(projected, { ...sqlite, operation: "inspect_plist" }),
  ).toBe(projected);
  // An error that names nothing projects no related fields.
  expect(
    projectAnalysisError(new AnalysisInputError("inspect_plist")).details ?? {},
  ).not.toHaveProperty("related_parameters");
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

  // Open-path BinaryTargetError has no details.operation; flags come from the
  // running command's open_binary bindings, while MCP projection stays flag-free.
  const loadRejected = projectAnalysisError(
    new BinaryTargetError("/tmp/image.bin", "unaligned entry", {
      constraint: "load_selection_rejected",
    }),
  );
  expect(loadRejected.details).toMatchObject({
    related_parameters: ["format", "architecture", "entry_point"],
  });
  expect(loadRejected.details).not.toHaveProperty("related_cli_flags");
  expect(JSON.stringify(loadRejected)).not.toContain("--target-format");

  const cliLoadRejected = projectCliCommandOutput(
    { error: "Analysis failed", ...loadRejected },
    { operations: inspectEntry.operations, commands: entries },
  );
  expect(cliLoadRejected).toMatchObject({
    error: "Analysis failed",
    details: {
      related_parameters: ["format", "architecture", "entry_point"],
      related_cli_flags: {
        format: "--target-format",
        architecture: "--architecture",
        entry_point: "--entry-point",
      },
    },
  });

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

  // In one-shot mode where only the running registrar was loaded, recorded
  // canonical commands from other registrars still resolve.
  expect(
    projectCliCommandOutput(
      projectAnalysisError(
        new BinaryTargetError("/tmp/module.wasm", "wasm module", {
          constraint: "wasm_requires_static_inspection",
        }),
      ),
      {
        operations: inspectEntry.operations,
        commands: [inspectEntry],
        recordedCommands: { "inspect-wasm-artifact": "wasm" },
      },
    ),
  ).toMatchObject({
    details: {
      related_operations: ["inspect_wasm_artifact"],
      related_cli_commands: {
        inspect_wasm_artifact: "rea inspect-wasm-artifact",
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
