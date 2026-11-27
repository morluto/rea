import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { expect, it } from "vitest";
import { functionDossierSchema } from "../../../src/domain/native/functionDossier.js";
import { ghidraFunctionDossier } from "../../../src/domain/ghidraValues.fixture.js";
import {
  jsonValueSchema,
  type JsonValue,
} from "../../../src/domain/jsonValue.js";
import { MAX_NATIVE_TYPE_DECLARATIONS_LENGTH } from "../../../src/domain/native/nativeDataType.js";
import { MAX_NATIVE_FUNCTION_SIGNATURE_LENGTH } from "../../../src/domain/native/nativeFunctionAnnotations.js";
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
    maximum: MAX_NATIVE_FUNCTION_SIGNATURE_LENGTH,
    expected: 4096,
  },
  {
    operation: "define_native_data_types",
    field: "declarations",
    maximum: MAX_NATIVE_TYPE_DECLARATIONS_LENGTH,
    expected: 16384,
  },
] as const)(
  "admits $field at its ceiling and refuses one more unit before the bridge, naming the limit",
  async ({ operation, field, maximum, expected }) => {
    expect(maximum).toBe(expected);
    const harness = await connectGhidraMcp(
      `ghidra-${field}-ceiling`,
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
      const { error } = parseMcpToolError(await call(expected + 1));
      expect(error).toMatchObject({
        code: "invalid_request",
        details: { issues: [{ path: [field], maximum: expected }] },
      });
      expect(harness.calls.length).toBe(before);
      expect((await call(expected)).isError).not.toBe(true);
      expect(harness.calls.slice(before)).toEqual([operation]);
    } finally {
      await harness.close();
    }
  },
);
