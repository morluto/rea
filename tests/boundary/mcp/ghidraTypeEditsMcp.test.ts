import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { expect, it } from "vitest";
import { functionDossierSchema } from "../../../src/domain/native/functionDossier.js";
import { ghidraFunctionDossier } from "../../../src/domain/ghidraValues.fixture.js";
import {
  jsonValueSchema,
  type JsonValue,
} from "../../../src/domain/jsonValue.js";
import { err, ok } from "../../../src/domain/result.js";
import {
  bindGhidraSessionFailure,
  GhidraSessionError,
} from "../../../src/ghidra/GhidraSessionError.js";
import { GhidraRemoteError } from "../../../src/ghidra/protocol.js";
import { connectGhidraMcp, ghidraFixtureResult } from "./ghidraMcpHarness.js";

/** A bridge refusal as the client receives it, with the value the bridge measured. */
const bridgeRefusal = (
  remoteCode: string,
  message: string,
  requiredValue: number,
): GhidraSessionError =>
  new GhidraSessionError(
    "remote",
    message,
    {},
    {
      remoteCode,
      cause: new GhidraRemoteError(
        remoteCode,
        message,
        undefined,
        requiredValue,
      ),
    },
  );

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
      "declarations contains the directive #define at line 2, column 1; Ghidra's C parser would not apply it as written, so nothing was changed",
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
    parameter: "signature_max_utf16",
    rangeMaximum: 4096,
  },
  {
    operation: "define_native_data_types",
    field: "declarations",
    parameter: "declarations_max_utf16",
    rangeMaximum: 8192,
  },
] as const)(
  "refuses $parameter outside its range before the bridge and forwards text of any length",
  async ({ operation, field, parameter, rangeMaximum }) => {
    const requests: Readonly<Record<string, JsonValue>>[] = [];
    const harness = await connectGhidraMcp(
      `ghidra-${field}-range`,
      (requested, input) => {
        requests.push(input);
        return Promise.resolve(
          ok(
            requested === "define_native_data_types"
              ? { types: [SESSION_TYPE], effects: DEFINITION_EFFECTS }
              : annotationReply("int fixture_main(void)", "user_defined"),
          ),
        );
      },
    );
    try {
      const call = (values: Record<string, JsonValue>) =>
        harness.mcp.callTool({
          name: operation,
          arguments: {
            ...(operation === "annotate_native_function"
              ? { procedure: "0x401000" }
              : {}),
            ...values,
          },
        });
      const before = harness.calls.length;
      for (const bound of [15, rangeMaximum + 1]) {
        const { error } = parseMcpToolError(
          await call({ [field]: SIGNATURE, [parameter]: bound }),
        );
        expect(error).toMatchObject({
          code: "invalid_request",
          details: { issues: [{ path: [parameter] }] },
        });
      }
      if (operation === "annotate_native_function") {
        // A bound without the text it bounds is an ignored option.
        const { error } = parseMcpToolError(
          await call({ name: "renamed", [parameter]: 64 }),
        );
        expect(error).toMatchObject({
          code: "invalid_request",
          details: { issues: [{ path: [parameter] }] },
        });
      }
      expect(harness.calls.length).toBe(before);
      // The bridge measures the text, so a long one is the producer's to refuse.
      const long = "x".repeat(rangeMaximum + 1);
      expect((await call({ [field]: long })).isError).not.toBe(true);
      expect(
        (await call({ [field]: SIGNATURE, [parameter]: rangeMaximum })).isError,
      ).not.toBe(true);
      expect(requests.slice(-2).map((request) => request[parameter])).toEqual([
        undefined,
        rangeMaximum,
      ]);
      expect(requests.at(-2)?.[field]).toBe(long);
    } finally {
      await harness.close();
    }
  },
);

it.each([
  {
    name: "a default bound",
    operation: "annotate_native_function",
    remoteCode: "signature_length_limit",
    text: "x".repeat(2049),
    bound: undefined,
    limit: {
      parameter: "signature_max_utf16",
      effective_value: 2048,
      minimum: 16,
      maximum: 4096,
      default_value: 2048,
      required_value: 2049,
    },
    recovery:
      /Pass a larger signature_max_utf16 on .*annotate_native_function.*\(at least 2049; range 16\.\.4096\), then retry/u,
  },
  {
    name: "the caller's bound",
    operation: "define_native_data_types",
    remoteCode: "declarations_length_limit",
    text: "x".repeat(300),
    bound: 256,
    limit: {
      parameter: "declarations_max_utf16",
      effective_value: 256,
      minimum: 16,
      maximum: 8192,
      default_value: 4096,
      required_value: 300,
    },
    recovery:
      /Pass a larger declarations_max_utf16 .*at least 300; range 16\.\.8192/u,
  },
  {
    name: "text above the maximum",
    operation: "define_native_data_types",
    remoteCode: "declarations_length_limit",
    text: "x".repeat(8193),
    bound: undefined,
    limit: {
      parameter: "declarations_max_utf16",
      effective_value: 4096,
      minimum: 16,
      maximum: 8192,
      default_value: 4096,
      required_value: 8193,
    },
    recovery:
      /requires 8193, above the declarations_max_utf16 maximum \(16\.\.8192\); narrow the request/u,
  },
] as const)(
  "binds a length refusal under $name to its per-call control",
  async ({ operation, remoteCode, text, bound, limit, recovery }) => {
    const field =
      operation === "annotate_native_function" ? "signature" : "declarations";
    const message = `${field} has ${String(text.length)} UTF-16 code units`;
    const harness = await connectGhidraMcp(
      `ghidra-${remoteCode}`,
      (requested, input) =>
        Promise.resolve(
          requested === operation
            ? err(bridgeRefusal(remoteCode, message, text.length))
            : ok(ghidraFixtureResult(requested, input)),
        ),
    );
    try {
      const { error } = parseMcpToolError(
        await harness.mcp.callTool({
          name: operation,
          arguments: {
            ...(operation === "annotate_native_function"
              ? { procedure: "0x401000" }
              : {}),
            [field]: text,
            ...(bound === undefined ? {} : { [limit.parameter]: bound }),
          },
        }),
      );
      expect(error).toMatchObject({
        code: "resource_constraint",
        category: "resource_constraint",
        retryable: false,
        details: {
          operation,
          limit: {
            control_kind: "parameter",
            unit: "count",
            applies_at: "next_call",
            ...limit,
          },
        },
      });
      expect(error.message).toContain(message);
      expect(error.message).toContain(
        `${limit.parameter} admits at most ${String(limit.effective_value)}`,
      );
      expect(error.message).toContain("Nothing in this call was applied");
      expect(error.remediation.action).toMatch(recovery);
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
    name: "the default bound",
    operation: "annotate_native_function",
    bound: undefined,
    required: 9,
    effective: 8,
    recovery:
      /Pass a larger parenthesis_max_depth .*annotate_native_function.*\(at least 9; range 1\.\.12\), then retry/u,
  },
  {
    name: "the caller's bound",
    operation: "annotate_native_function",
    bound: 3,
    required: 5,
    effective: 3,
    recovery:
      /Pass a larger parenthesis_max_depth .*at least 5; range 1\.\.12/u,
  },
  {
    name: "nesting above the maximum",
    operation: "annotate_native_function",
    bound: undefined,
    required: 13,
    effective: 8,
    recovery:
      /requires 13, above the parenthesis_max_depth maximum \(1\.\.12\); narrow the request/u,
  },
] as const)(
  "binds a nesting refusal under $name to its per-call control",
  async ({ operation, bound, required, effective, recovery }) => {
    const field =
      operation === "annotate_native_function" ? "signature" : "declarations";
    const message = `${field} nests parentheses ${String(required)} levels deep, first beyond ${String(effective)} at line 1, column 30`;
    const harness = await connectGhidraMcp(
      `ghidra-parenthesis-depth-${String(required)}`,
      (requested, input) =>
        Promise.resolve(
          requested === operation
            ? err(bridgeRefusal("parenthesis_depth_limit", message, required))
            : ok(ghidraFixtureResult(requested, input)),
        ),
    );
    try {
      const { error } = parseMcpToolError(
        await harness.mcp.callTool({
          name: operation,
          arguments: {
            ...(operation === "annotate_native_function"
              ? { procedure: "0x401000", signature: SIGNATURE }
              : { declarations: DECLARATIONS }),
            ...(bound === undefined ? {} : { parenthesis_max_depth: bound }),
          },
        }),
      );
      expect(error).toMatchObject({
        code: "resource_constraint",
        retryable: false,
        details: {
          operation,
          limit: {
            control_kind: "parameter",
            parameter: "parenthesis_max_depth",
            effective_value: effective,
            unit: "count",
            minimum: 1,
            maximum: 12,
            default_value: 8,
            applies_at: "next_call",
            required_value: required,
          },
        },
      });
      // An adjustable budget, not a fixed ceiling.
      expect(error.details).toMatchObject({
        refusal: {
          kind: "adjustable_budget",
          control: "parenthesis_max_depth",
        },
      });
      expect(error.message).toContain(message);
      expect(error.message).toContain(
        `parenthesis_max_depth admits at most ${String(effective)} levels`,
      );
      expect(error.remediation.action).toMatch(recovery);
    } finally {
      await harness.close();
    }
  },
);

it("reports a type chained deeper than Ghidra's stack admits as a fixed ceiling", async () => {
  const message =
    "declarations defines rea_chain, chained 300 levels deep through pointers, arrays, typedefs, members or existing database types";
  const harness = await connectGhidraMcp(
    "ghidra-type-depth",
    (requested, input) =>
      Promise.resolve(
        requested === "define_native_data_types"
          ? err(
              new GhidraSessionError(
                "remote",
                message,
                {},
                { remoteCode: "type_depth_limit" },
              ),
            )
          : ok(ghidraFixtureResult(requested, input)),
      ),
  );
  try {
    const { error } = parseMcpToolError(
      await harness.mcp.callTool({
        name: "define_native_data_types",
        arguments: { declarations: DECLARATIONS },
      }),
    );
    expect(error).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      details: {
        operation: "define_native_data_types",
        refusal: {
          kind: "fixed_ceiling",
          allowance: "The Ghidra C type depth allowance",
          limit: 256,
          unit: "levels",
        },
      },
    });
    expect(error.details).not.toHaveProperty("limit");
    expect(error.message).toContain(`${message}, above the 256-level limit`);
    expect(error.remediation.action).toMatch(
      /only fewer nested pointer, array, typedef or member levels does/u,
    );
    expect(error.remediation.action).not.toMatch(/Split the chain/u);
    // The refusal leaves the session usable.
    const next = await harness.mcp.callTool({
      name: "procedure_info",
      arguments: { procedure: "0x401000" },
    });
    expect(next.isError).not.toBe(true);
  } finally {
    await harness.close();
  }
});

it("returns the qualifiers each edit could not record", async () => {
  const qualifier = { qualifier: "const", line: 1, column: 14 };
  // Every other pure qualifier the bridge reports.
  const PURE_QUALIFIERS = ["restrict", "__unaligned", "__w64"].map(
    (name, index) => ({ qualifier: name, line: 2, column: 1 + index }),
  );
  const harness = await connectGhidraMcp(
    "ghidra-dropped-qualifiers",
    (requested) =>
      Promise.resolve(
        ok(
          requested === "define_native_data_types"
            ? {
                types: [SESSION_TYPE],
                dropped_qualifiers: [qualifier, ...PURE_QUALIFIERS],
                effects: DEFINITION_EFFECTS,
              }
            : {
                ...(annotationReply(SIGNATURE, "user_defined") as Record<
                  string,
                  JsonValue
                >),
                dropped_qualifiers: [
                  { ...qualifier, parameter_index: 0 },
                  {
                    qualifier: "volatile",
                    line: 1,
                    column: 1,
                    parameter_index: null,
                  },
                ],
              },
        ),
      ),
  );
  try {
    const defined = await harness.mcp.callTool({
      name: "define_native_data_types",
      arguments: { declarations: DECLARATIONS },
    });
    expect(defined.structuredContent).toMatchObject({
      normalized_result: {
        dropped_qualifiers: [qualifier, ...PURE_QUALIFIERS],
      },
    });
    const annotated = await harness.mcp.callTool({
      name: "annotate_native_function",
      arguments: { procedure: "0x401000", signature: SIGNATURE },
    });
    expect(annotated.structuredContent).toMatchObject({
      normalized_result: {
        dropped_qualifiers: [
          { ...qualifier, parameter_index: 0 },
          { qualifier: "volatile", parameter_index: null },
        ],
      },
    });
  } finally {
    await harness.close();
  }
});

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

it("refuses non-equivalent types that share one Ghidra name and stores nothing", async () => {
  const remoteCode = "conflicting_type_definitions";
  const failure = bindGhidraSessionFailure((scope) => ({
    diagnostic_scope: scope,
  }))(
    "remote",
    "declarations define different types under one name: item; nothing was changed",
    new GhidraRemoteError(
      remoteCode,
      "declarations define different types under one name: item; nothing was changed",
    ),
    { remoteCode },
  );
  const harness = await connectGhidraMcp(
    "ghidra-conflicting-type-definitions",
    (requested, input) =>
      Promise.resolve(
        requested === "define_native_data_types"
          ? err(failure)
          : ok(ghidraFixtureResult(requested, input)),
      ),
  );
  try {
    const { error } = parseMcpToolError(
      await harness.mcp.callTool({
        name: "define_native_data_types",
        arguments: {
          declarations: "struct item { int x; }; typedef int item;",
        },
      }),
    );
    expect(error).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      retryable: false,
      details: {
        operation: "define_native_data_types",
        issues: [{ path: ["declarations"], reason: "invalid_value" }],
        diagnostics: {
          diagnostic_scope: "request",
          remote_code: remoteCode,
        },
        related_operations: ["define_native_data_types"],
      },
    });
    expect(error.recovery).toBeUndefined();
    const next = await harness.mcp.callTool({
      name: "procedure_info",
      arguments: { procedure: "0x401000" },
    });
    expect(next.isError).not.toBe(true);
  } finally {
    await harness.close();
  }
});

it("reports the prototype of a function-pointer member's function type", async () => {
  const prototype = {
    return_type: "/int",
    parameters: [
      { name: "path", type: "/char *" },
      { name: null, type: "/int" },
    ],
    total_parameters: 2,
    parameters_truncated: false,
    varargs: true,
    calling_convention: "__cdecl",
  };
  let functionDefinition: JsonValue = prototype;
  const harness = await connectGhidraMcp(
    "ghidra-function-type",
    (requested, input) =>
      Promise.resolve(
        requested === "inspect_native_data_type"
          ? ok(
              jsonValueSchema.parse({
                status: "available",
                reason: null,
                id: "/rea_caller_defined/ops.open",
                name: "ops.open",
                kind: "function",
                source: "caller-defined",
                source_archive: null,
                address: null,
                size_bytes: null,
                alignment_bytes: null,
                packing_enabled: null,
                referenced_type: null,
                array_count: null,
                array_stride_bytes: null,
                function_definition: functionDefinition,
                fields: [],
                members: [],
                total_fields: 0,
                truncated: false,
                limitations: [],
              }),
            )
          : ok(ghidraFixtureResult(requested, input)),
      ),
  );
  try {
    const inspected = await harness.mcp.callTool({
      name: "inspect_native_data_type",
      arguments: { type: "/rea_caller_defined/ops.open" },
    });
    expect(inspected.isError, JSON.stringify(inspected.content)).not.toBe(true);
    expect(inspected.structuredContent).toMatchObject({
      normalized_result: {
        kind: "function",
        source: "caller-defined",
        function_definition: prototype,
      },
    });
    // A prototype outside the contract is not delivered as an observation.
    functionDefinition = jsonValueSchema.parse({
      ...prototype,
      varargs: "yes",
    });
    expect(
      parseMcpToolError(
        await harness.mcp.callTool({
          name: "inspect_native_data_type",
          arguments: { type: "/rea_caller_defined/ops.open" },
        }),
      ),
    ).toMatchObject({ error: { code: "unreadable_output" } });
  } finally {
    await harness.close();
  }
});
