import { expect, it } from "vitest";
import { err, ok } from "../../../src/domain/result.js";
import { GhidraSessionError } from "../../../src/ghidra/GhidraSessionError.js";
import { GhidraRemoteError } from "../../../src/ghidra/protocol.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { connectGhidraMcp, ghidraFixtureResult } from "./ghidraMcpHarness.js";

it.each(["compact"] as const)(
  "preserves actionable Ghidra procedure ambiguity over MCP (%s)",
  async (profile) => {
    const message =
      "Ghidra procedure name is ambiguous: shared; select an exact entry address from [0x1000, 0x2000]";
    const harness = await connectGhidraMcp(
      "ambiguous-ghidra-procedure",
      (operation, input) =>
        Promise.resolve(
          operation === "list_names"
            ? ok(ghidraFixtureResult(operation, input))
            : err(
                new GhidraSessionError(
                  "remote",
                  message,
                  {},
                  {
                    remoteCode: "procedure_ambiguous",
                    cause: new GhidraRemoteError(
                      "procedure_ambiguous",
                      message,
                      ["0x1000", "0x2000"],
                    ),
                  },
                ),
              ),
        ),
      { environment: { REA_MCP_OUTPUT_SCHEMA_PROFILE: profile } },
    );
    try {
      const response = await harness.mcp.callTool({
        name: "analyze_function",
        arguments: { procedure: "shared" },
      });
      const { error } = parseMcpToolError(response);
      expect(error).toMatchObject({
        code: "invalid_request",
        message,
        remediation: {
          action: expect.stringContaining("explicit procedure entry address"),
        },
      });
      expect(error.recovery).toBeUndefined();
      // The bridge's candidates survive as the typed ambiguity refusal.
      expect(JSON.stringify(error)).toContain("0x2000");
      // find_xrefs_to_name keeps the provider's ambiguity instead of reporting
      // the name as not found.
      const lookup = parseMcpToolError(
        await harness.mcp.callTool({
          name: "find_xrefs_to_name",
          arguments: { name: "shared" },
        }),
      ).error;
      expect(lookup).toMatchObject({ code: "invalid_request", message });
      const malformed = await harness.mcp.callTool({
        name: "analyze_function",
        arguments: { procedure: 42 },
      });
      expect(parseMcpToolError(malformed).error).toMatchObject({
        code: "invalid_request",
        recovery: { kind: "inspect_input_contract" },
        details: {
          issues: [
            expect.objectContaining({
              path: ["procedure"],
              reason: "invalid_type",
            }),
          ],
        },
      });
    } finally {
      await harness.close();
    }
  },
);

it.each(["compact"] as const)(
  "keeps file-offset mapping ambiguity distinct from function identity (%s)",
  async (profile) => {
    const message =
      "File offset 0x400 has multiple loaded mappings: [0x1000, 0x2000]; select an explicit analysis address";
    const harness = await connectGhidraMcp(
      "ambiguous-ghidra-offset",
      (operation, input) =>
        Promise.resolve(
          operation === "list_names"
            ? ok(ghidraFixtureResult(operation, input))
            : err(
                new GhidraSessionError(
                  "remote",
                  message,
                  {},
                  { remoteCode: "file_offset_ambiguous" },
                ),
              ),
        ),
      { environment: { REA_MCP_OUTPUT_SCHEMA_PROFILE: profile } },
    );
    try {
      const response = await harness.mcp.callTool({
        name: "procedure_pseudo_code",
        arguments: { procedure: "file-offset:0x400" },
      });
      const { error } = parseMcpToolError(response);
      expect(error).toMatchObject({
        code: "invalid_request",
        message,
        remediation: {
          action: expect.stringContaining("ram:0x1000"),
        },
      });
      expect(error.remediation.action).toContain("inspect_native_load_image");
      expect(error.remediation.action).toContain("bare 0x");
      expect(error.recovery).toBeUndefined();
    } finally {
      await harness.close();
    }
  },
);

it("answers a leaf name Ghidra finds ambiguous by its unique exact name", async () => {
  const message =
    "Ghidra procedure name is ambiguous: work; select an exact entry address from [0x401000, 0x402000]";
  const asked: unknown[] = [];
  const harness = await connectGhidraMcp(
    "exact-name-over-leaf-ambiguity",
    (operation, input) => {
      if (operation === "list_names")
        return Promise.resolve(
          ok([
            {
              address: "0x401000",
              value: "work",
              symbol: {
                primary: true,
                dynamic: false,
                external: false,
                type: "function",
                source: "analysis",
              },
            },
            {
              address: "0x402000",
              value: "ns::work",
              symbol: {
                primary: true,
                dynamic: false,
                external: false,
                type: "function",
                source: "analysis",
              },
            },
          ]),
        );
      if (operation === "resolve_containing_procedure")
        return Promise.resolve(ok(ghidraFixtureResult(operation, input)));
      if (operation === "procedure_callers") {
        asked.push(input.procedure);
        if (input.procedure === "0x401000")
          return Promise.resolve(ok(ghidraFixtureResult(operation, input)));
      }
      return Promise.resolve(
        err(
          new GhidraSessionError(
            "remote",
            message,
            {},
            {
              remoteCode: "procedure_ambiguous",
              cause: new GhidraRemoteError("procedure_ambiguous", message, [
                "0x401000",
                "0x402000",
              ]),
            },
          ),
        ),
      );
    },
  );
  try {
    const response = await harness.mcp.callTool({
      name: "procedure_callers",
      arguments: { procedure: "work" },
    });
    expect(response.isError).not.toBe(true);
    // The exact name wins before Ghidra's leaf lookup can match ns::work.
    expect(asked).toEqual(["0x401000"]);
  } finally {
    await harness.close();
  }
});

it("answers procedure_callers for the exact data label, not a function sharing its leaf name", async () => {
  const symbol = (type: string) => ({
    primary: true,
    dynamic: false,
    external: false,
    type,
    source: "analysis" as const,
  });
  const harness = await connectGhidraMcp(
    "exact-label-over-leaf-function",
    (operation, input) => {
      if (operation === "list_names")
        return Promise.resolve(
          ok([
            { address: "0x403000", value: "work", symbol: symbol("label") },
            {
              address: "0x402000",
              value: "ns::work",
              symbol: symbol("function"),
            },
          ]),
        );
      if (operation === "resolve_containing_procedure")
        return Promise.resolve(
          ok({
            query_address: "0x403000",
            found: false,
            procedure: null,
            reason: "not_in_procedure",
          }),
        );
      if (operation === "procedure_callers")
        // Ghidra's leaf lookup would answer "work" with ns::work's callers.
        return Promise.resolve(
          ok({
            value: input.procedure === "0x403000" ? ["0x401100"] : ["0x409900"],
            limitations: [],
          }),
        );
      return Promise.resolve(ok(ghidraFixtureResult(operation, input)));
    },
  );
  try {
    const response = await harness.mcp.callTool({
      name: "procedure_callers",
      arguments: { procedure: "work" },
    });
    expect(response.structuredContent).toMatchObject({
      normalized_result: ["0x401100"],
    });
  } finally {
    await harness.close();
  }
});
