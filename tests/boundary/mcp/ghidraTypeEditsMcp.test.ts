import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { expect, it } from "vitest";
import { functionDossierSchema } from "../../../src/domain/native/functionDossier.js";
import { ghidraFunctionDossier } from "../../../src/domain/ghidraValues.fixture.js";
import {
  jsonValueSchema,
  type JsonValue,
} from "../../../src/domain/jsonValue.js";
import { err, ok } from "../../../src/domain/result.js";
import { GhidraSessionError } from "../../../src/ghidra/GhidraSessionError.js";
import { connectGhidraMcp, ghidraFixtureResult } from "./ghidraMcpHarness.js";

const SESSION_TYPE = {
  id: "/rea_caller_defined/session",
  name: "session",
  kind: "struct",
  size_bytes: 56,
  status: "defined",
};
const DEFINITION_EFFECTS = {
  scope: "session-analysis-database",
  source_bytes_modified: false,
};
const DECLARATIONS = "struct session { int id; struct session *next; };";
const SIGNATURE = "double total(struct session *s, unsigned mask)";

const annotationReply = (signature: string, source: string) => {
  const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
  return jsonValueSchema.parse({
    annotations: {
      address: dossier.procedure.address,
      name: dossier.procedure.name,
      comment: null,
      inline_comment: null,
      signature,
      signature_source: source,
      calling_convention: "__stdcall",
    },
    dossier,
    effects: {
      scope: "session-analysis-database",
      source_bytes_modified: false,
      persists_after_close: false,
    },
  });
};

it("returns caller-defined type readback and refuses a reply outside the contract", async () => {
  let output: JsonValue = {
    types: [SESSION_TYPE],
    effects: DEFINITION_EFFECTS,
  };
  const requests: Readonly<Record<string, JsonValue>>[] = [];
  const harness = await connectGhidraMcp(
    "ghidra-type-definitions",
    (_, input) => {
      requests.push(input);
      return Promise.resolve(ok(output));
    },
  );
  try {
    const defined = await harness.mcp.callTool({
      name: "define_native_data_types",
      arguments: { declarations: DECLARATIONS },
    });
    expect(defined.isError).not.toBe(true);
    expect(defined.structuredContent).toMatchObject({
      operation: "define_native_data_types",
      normalized_result: { types: [SESSION_TYPE], effects: DEFINITION_EFFECTS },
    });
    // The caller's text reaches the bridge unchanged.
    expect(requests).toEqual([{ declarations: DECLARATIONS }]);
    for (const value of [
      { types: [], effects: DEFINITION_EFFECTS },
      {
        types: [{ ...SESSION_TYPE, status: "replaced" }],
        effects: DEFINITION_EFFECTS,
      },
      {
        types: [{ ...SESSION_TYPE, kind: "pointer" }],
        effects: DEFINITION_EFFECTS,
      },
      {
        types: [SESSION_TYPE],
        effects: { ...DEFINITION_EFFECTS, source_bytes_modified: true },
      },
    ]) {
      output = jsonValueSchema.parse(value);
      const reply = await harness.mcp.callTool({
        name: "define_native_data_types",
        arguments: { declarations: DECLARATIONS },
      });
      expect(parseMcpToolError(reply)).toMatchObject({
        error: { code: "unreadable_output" },
      });
    }
  } finally {
    await harness.close();
  }
});

it("reports the applied prototype and its source with the annotation readback", async () => {
  const requests: Readonly<Record<string, JsonValue>>[] = [];
  let output = annotationReply(
    "double fixture_main(session * s, uint mask)",
    "user_defined",
  );
  const harness = await connectGhidraMcp("ghidra-signature", (_, input) => {
    requests.push(input);
    return Promise.resolve(ok(output));
  });
  try {
    const procedure = "0x401000";
    const applied = await harness.mcp.callTool({
      name: "annotate_native_function",
      arguments: { procedure, signature: SIGNATURE },
    });
    expect(applied.isError).not.toBe(true);
    expect(applied.structuredContent).toMatchObject({
      normalized_result: {
        annotations: {
          signature: "double fixture_main(session * s, uint mask)",
          signature_source: "user_defined",
          calling_convention: "__stdcall",
        },
      },
    });
    // A signature is a complete edit on its own and is forwarded verbatim.
    expect(requests).toEqual([{ procedure, signature: SIGNATURE }]);
    // A reply without prototype readback cannot prove what was applied.
    const { annotations, ...rest } = annotationReply(
      "int f(void)",
      "analysis",
    ) as {
      annotations: Record<string, JsonValue>;
    };
    const { signature_source: _source, ...unsourced } = annotations;
    output = jsonValueSchema.parse({ ...rest, annotations: unsourced });
    const reply = await harness.mcp.callTool({
      name: "annotate_native_function",
      arguments: { procedure, signature: SIGNATURE },
    });
    expect(parseMcpToolError(reply)).toMatchObject({
      error: { code: "unreadable_output" },
    });
  } finally {
    await harness.close();
  }
});

it.each([
  {
    operation: "annotate_native_function",
    remoteCode: "invalid_function_signature",
    field: "signature",
    message:
      'Ghidra\'s C parser rejected signature: Encountered " ";" "; "" at line 1, column 27.',
    recovery: undefined,
  },
  {
    operation: "annotate_native_function",
    remoteCode: "unknown_data_type",
    field: "signature",
    message: "signature uses types the database does not define: session",
    recovery: {
      action: /define_native_data_types.*Nothing in this call was applied/u,
      operations: ["define_native_data_types"],
    },
  },
  {
    operation: "define_native_data_types",
    remoteCode: "invalid_type_declarations",
    field: "declarations",
    message:
      "declarations nests parentheses deeper than 8 levels at UTF-16 index 25. This release has no runtime override.",
    recovery: undefined,
  },
  {
    operation: "define_native_data_types",
    remoteCode: "data_type_conflict",
    field: "declarations",
    message:
      "The database already holds types with these names: session (existing /session)",
    recovery: {
      action:
        /does not replace an existing type; nothing in this call was stored/u,
      operations: ["inspect_native_data_type"],
    },
  },
] as const)(
  "attributes the $remoteCode refusal to $field and keeps the bridge's reason",
  async ({ operation, remoteCode, field, message, recovery }) => {
    const harness = await connectGhidraMcp(
      `ghidra-${remoteCode}`,
      (requested, input) =>
        Promise.resolve(
          requested === operation
            ? err(new GhidraSessionError("remote", message, {}, { remoteCode }))
            : ok(ghidraFixtureResult(requested, input)),
        ),
    );
    try {
      const reply = await harness.mcp.callTool({
        name: operation,
        arguments:
          operation === "annotate_native_function"
            ? { procedure: "0x401000", name: "renamed", signature: SIGNATURE }
            : { declarations: DECLARATIONS },
      });
      const { error } = parseMcpToolError(reply);
      expect(error).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
        retryable: false,
        details: {
          operation,
          issues: [{ path: [field], reason: "invalid_value", message }],
        },
      });
      if (recovery === undefined) {
        expect(error.recovery).toMatchObject({
          kind: "inspect_input_contract",
        });
      } else {
        expect(error.remediation.action).toMatch(recovery.action);
        expect(error.details).toMatchObject({
          related_operations: recovery.operations,
        });
        // The text satisfies the schema, so rereading it cannot correct the call.
        expect(error.recovery).toBeUndefined();
      }
      // The refusal leaves the session usable.
      const next = await harness.mcp.callTool({
        name: "procedure_info",
        arguments: { procedure: "0x401000" },
      });
      expect(next.isError).not.toBe(true);
    } finally {
      await harness.close();
    }
  },
);

it.each([
  {
    operation: "annotate_native_function",
    field: "signature",
    rangeMaximum: 4096,
  },
  {
    operation: "define_native_data_types",
    field: "declarations",
    rangeMaximum: 8192,
  },
] as const)(
  "refuses $field beyond its control's range maximum before the bridge",
  async ({ operation, field, rangeMaximum }) => {
    const harness = await connectGhidraMcp(
      `ghidra-${field}-range`,
      (requested) =>
        Promise.resolve(
          ok(
            requested === "define_native_data_types"
              ? { types: [SESSION_TYPE], effects: DEFINITION_EFFECTS }
              : annotationReply("int fixture_main(void)", "user_defined"),
          ),
        ),
    );
    try {
      const call = (length: number) =>
        harness.mcp.callTool({
          name: operation,
          arguments: {
            ...(operation === "annotate_native_function"
              ? { procedure: "0x401000" }
              : {}),
            [field]: "x".repeat(length),
          },
        });
      const before = harness.calls.length;
      const { error } = parseMcpToolError(await call(rangeMaximum + 1));
      expect(error).toMatchObject({
        code: "invalid_request",
        details: { issues: [{ path: [field], maximum: rangeMaximum }] },
      });
      expect(harness.calls.length).toBe(before);
      // Within the range the bridge, which holds the effective value, decides.
      expect((await call(rangeMaximum)).isError).not.toBe(true);
      expect(harness.calls.slice(before)).toEqual([operation]);
    } finally {
      await harness.close();
    }
  },
);

it.each([
  {
    operation: "annotate_native_function",
    remoteCode: "signature_length_limit",
    message: "signature has 2049 UTF-16 code units",
    environment: "REA_GHIDRA_SIGNATURE_MAX_UTF16",
    configured: undefined,
    limit: {
      effective_value: 2048,
      minimum: 16,
      maximum: 4096,
      default_value: 2048,
    },
    source: "default",
    recovery:
      /set REA_GHIDRA_SIGNATURE_MAX_UTF16 \(16\.\.4096\).*start a new REA process; update_analysis_settings does not change it/u,
  },
  {
    operation: "define_native_data_types",
    remoteCode: "declarations_length_limit",
    message: "declarations has 300 UTF-16 code units",
    environment: "REA_GHIDRA_TYPE_DECLARATIONS_MAX_UTF16",
    configured: "256",
    limit: {
      effective_value: 256,
      minimum: 16,
      maximum: 8192,
      default_value: 4096,
    },
    source: "environment",
    recovery:
      /Split the definitions across several calls.*REA_GHIDRA_TYPE_DECLARATIONS_MAX_UTF16 \(16\.\.8192\)/u,
  },
  {
    operation: "define_native_data_types",
    remoteCode: "parenthesis_depth_limit",
    message:
      "declarations nests parentheses 13 levels deep at line 1, column 30",
    environment: "REA_GHIDRA_C_MAX_PARENTHESIS_DEPTH",
    configured: "12",
    limit: { effective_value: 12, minimum: 1, maximum: 12, default_value: 8 },
    source: "environment",
    recovery:
      /REA_GHIDRA_C_MAX_PARENTHESIS_DEPTH is already at its maximum of 12/u,
  },
] as const)(
  "names $environment, its effective value, source and range when the bridge refuses over it",
  async ({
    operation,
    remoteCode,
    message,
    environment,
    configured,
    limit,
    source,
    recovery,
  }) => {
    const harness = await connectGhidraMcp(
      `ghidra-${remoteCode}`,
      (requested, input) =>
        Promise.resolve(
          requested === operation
            ? err(new GhidraSessionError("remote", message, {}, { remoteCode }))
            : ok(ghidraFixtureResult(requested, input)),
        ),
      configured === undefined
        ? {}
        : { configEnvironment: { [environment]: configured } },
    );
    try {
      const reply = await harness.mcp.callTool({
        name: operation,
        arguments:
          operation === "annotate_native_function"
            ? { procedure: "0x401000", signature: SIGNATURE }
            : { declarations: DECLARATIONS },
      });
      const { error } = parseMcpToolError(reply);
      expect(error).toMatchObject({
        code: "resource_constraint",
        category: "resource_constraint",
        retryable: false,
        details: {
          operation,
          limit: {
            control_kind: "environment",
            environment,
            unit: "count",
            applies_at: "next_startup",
            ...limit,
          },
          reported_limits: {
            boundary: environment,
            maximum: limit.effective_value,
            source,
            range_minimum: limit.minimum,
            range_maximum: limit.maximum,
            default_value: limit.default_value,
          },
        },
      });
      expect(error.message).toContain(message);
      expect(error.message).toContain(
        `${environment} admits at most ${String(limit.effective_value)}`,
      );
      expect(error.message).toContain(`source: ${source}`);
      expect(error.remediation.action).toMatch(recovery);
      expect(error.remediation.action).toContain(
        "Nothing in this call was applied.",
      );
      const next = await harness.mcp.callTool({
        name: "procedure_info",
        arguments: { procedure: "0x401000" },
      });
      expect(next.isError).not.toBe(true);
    } finally {
      await harness.close();
    }
  },
);

it.each(["annotate_native_function", "define_native_data_types"] as const)(
  "attributes an ambiguous type name in %s to its text and lists the recovery",
  async (operation) => {
    const message =
      "The type name size_t names different types in the database: /DWARF/size_t, /stddef.h/size_t";
    const harness = await connectGhidraMcp(
      `ghidra-ambiguous-${operation}`,
      (requested, input) =>
        Promise.resolve(
          requested === operation
            ? err(
                new GhidraSessionError(
                  "remote",
                  message,
                  {},
                  { remoteCode: "ambiguous_data_type" },
                ),
              )
            : ok(ghidraFixtureResult(requested, input)),
        ),
    );
    try {
      const { error } = parseMcpToolError(
        await harness.mcp.callTool({
          name: operation,
          arguments:
            operation === "annotate_native_function"
              ? { procedure: "0x401000", signature: SIGNATURE }
              : { declarations: DECLARATIONS },
        }),
      );
      expect(error).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: [
                operation === "annotate_native_function"
                  ? "signature"
                  : "declarations",
              ],
              message,
            },
          ],
          related_operations: [
            "inspect_native_data_type",
            "define_native_data_types",
          ],
        },
      });
      expect(error.remediation.action).toMatch(/unique in the database/u);
    } finally {
      await harness.close();
    }
  },
);
