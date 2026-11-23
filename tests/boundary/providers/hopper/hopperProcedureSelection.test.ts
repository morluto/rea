import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, expect, it } from "vitest";

import { createCli } from "../../../../src/cli.js";
import {
  cliCommand,
  cliCommands,
} from "../../../../src/cli/commandRegistry.js";
import { projectCliCommandOutput } from "../../../../src/cli/projectCliAnalysisResult.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import type { JsonValue } from "../../../../src/domain/jsonValue.js";
import { responseResult } from "../../../../src/hopper/protocol.js";
import { analysisClientFailureForOperation } from "../../../../src/providers/AnalysisClientFailure.js";

interface ProbeOutput {
  readonly results: Readonly<Record<string, Record<string, JsonValue>>>;
  readonly name_lookups: readonly string[];
}

let observed: ProbeOutput;

beforeAll(async () => {
  const fixture = fileURLToPath(
    new URL(
      "../../../fixtures/hopperProcedureSelectionProbe.py",
      import.meta.url,
    ),
  );
  const bridge = fileURLToPath(
    new URL("../../../../bridge/hopper_bridge.py", import.meta.url),
  );
  const { stdout } = await promisify(execFile)(
    "python3",
    ["-I", "-S", fixture, bridge],
    { timeout: 3_000 },
  );
  observed = JSON.parse(stdout) as ProbeOutput;
});

/** Carry one bridge diagnostic through the client and operation attribution. */
const procedureReferencesFailure = (selector: string) => {
  const diagnostic = observed.results[selector]?.diagnostic;
  const parsed = responseResult({
    id: 7,
    error: diagnostic as never,
  });
  if (parsed.ok) throw new Error("Expected a Hopper remote failure");
  return analysisClientFailureForOperation(
    parsed.error,
    "hopper",
    "procedure_references",
  );
};

it("Hopper preserves named-entry selection and explicit address containment", () => {
  for (const selector of ["entry", "alias_entry", "0x401004", "401004"])
    expect(observed.results[selector]).toEqual({ entry: "0x401000" });
  expect(observed.results.inner).toMatchObject({
    diagnostic_type: "invalid_request",
    message: expect.stringContaining(
      "inner at 0x401004 is inside procedure entry at 0x401000",
    ),
  });
  expect(observed.results["file-offset:0x4"]).toMatchObject({
    diagnostic_type: "invalid_request",
    message: expect.stringContaining("source-file coordinates"),
  });
  expect(observed.name_lookups).toEqual([
    "entry",
    "alias_entry",
    "inner",
    "401004",
    "CloseHandle",
    "missing_fn",
  ]);
});

it("Hopper reports a name outside every procedure as a resolved symbol and names xrefs", () => {
  expect(observed.results.CloseHandle?.diagnostic).toEqual({
    code: -32000,
    type: "selector_not_found",
    message:
      "Name CloseHandle resolves to 0x40b000, which is not inside a Hopper procedure",
    selector: { value: "CloseHandle", source: "symbol", address: "0x40b000" },
  });
  const failure = procedureReferencesFailure("CloseHandle");
  const continuing = projectAnalysisError(failure);
  expect(continuing).toMatchObject({
    code: "invalid_request",
    category: "invalid_input",
    message: expect.stringContaining("CloseHandle resolves to 0x40b000"),
    remediation: {
      action: expect.stringContaining("call xrefs with address 0x40b000"),
    },
    details: {
      operation: "procedure_references",
      diagnostic_type: "selector_not_found",
      selector: { value: "CloseHandle", source: "symbol", address: "0x40b000" },
      related_operations: ["xrefs"],
    },
  });
  // Recovery names contract operations only; each adapter renders its spelling.
  expect(continuing.remediation?.action).not.toMatch(/\bCLI\b|\brea \b|MCP/u);
  expect(continuing.message).not.toContain("requested address");

  const cli = createCli();
  const entry = cliCommand(cli, "procedure-references");
  if (entry === undefined) throw new Error("Expected procedure-references");
  expect(
    projectCliCommandOutput(projectAnalysisError(failure, "invocation"), {
      operations: entry.operations,
      commands: cliCommands(cli),
    }),
  ).toMatchObject({
    details: { related_cli_commands: { xrefs: "rea xrefs" } },
  });
});

it("Hopper keeps address and unknown-name misses on procedure inventory recovery", () => {
  expect(observed.results["0x40b000"]?.diagnostic).toMatchObject({
    type: "selector_not_found",
    message: "No procedure exists at 0x40b000",
    selector: { value: "0x40b000", source: "address", address: "0x40b000" },
  });
  expect(
    projectAnalysisError(procedureReferencesFailure("0x40b000")),
  ).toMatchObject({
    remediation: {
      action: expect.stringContaining("call xrefs with that address"),
    },
    details: {
      related_operations: ["search_procedures", "list_procedures", "xrefs"],
    },
  });

  expect(observed.results.missing_fn?.diagnostic).toMatchObject({
    type: "selector_not_found",
    message: "Unknown Hopper address or name: missing_fn",
    selector: { value: "missing_fn", source: "unresolved" },
  });
  const unknown = projectAnalysisError(
    procedureReferencesFailure("missing_fn"),
    "invocation",
  );
  expect(unknown.details).toMatchObject({
    related_operations: ["search_procedures", "list_procedures"],
  });
  expect(unknown.remediation?.action).not.toContain("list_names");
  const cli = createCli();
  const entry = cliCommand(cli, "procedure-references");
  if (entry === undefined) throw new Error("Expected procedure-references");
  expect(
    projectCliCommandOutput(unknown, {
      operations: entry.operations,
      commands: cliCommands(cli),
    }),
  ).toMatchObject({
    details: {
      related_cli_commands: {
        search_procedures: "rea search --kind procedures",
      },
    },
  });
});
