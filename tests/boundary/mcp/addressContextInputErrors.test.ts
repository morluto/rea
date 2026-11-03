import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { inspectAddressContext } from "../../../src/application/AnalysisContextQueries.js";
import {
  AnalysisInputError,
  AnalysisProtocolError,
} from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { err, ok } from "../../../src/domain/result.js";
import { SESSION_TOOL_CONTRACTS } from "../../../src/contracts/sessionToolContracts.js";
import { createServer } from "../../../src/server/createServer.js";

it.each([
  ["compact", false, "comment"],
  ["compact", true, "comment"],
  ["full", false, "comment"],
  ["full", true, "comment"],
  ["full", false, "list_bookmarks"],
] as const)(
  "preserves a local input refusal alongside successful facets (%s, conforms=%s, operation=%s)",
  async (profile, conforms, rejectedOperation) => {
    const identity = { id: "fixture", name: "Fixture", version: "1" };
    const directory = await createTestTempDirectory("rea-context-input-");
    const target = join(directory, "fixture.com");
    await writeFile(target, Buffer.from([0xb8, 0x00, 0x4c, 0xcd, 0x21]));
    const inputFailure = new AnalysisInputError(
      rejectedOperation,
      {
        userMessage: "Controlled facet refusal",
        conformsToInputContract: conforms,
        diagnostics: { producer_fact: "retained" },
      },
      [
        {
          path: [rejectedOperation === "comment" ? "address" : "document"],
          reason: "invalid_value",
          expected: "controlled-value",
        },
      ],
    );
    const session = createTestBinarySession(() => ({
      execute: async (operation) => {
        if (operation === rejectedOperation) return err(inputFailure);
        if (operation === "inline_comment")
          return err(new AnalysisProtocolError("controlled provider failure"));
        const result =
          operation === "address_name"
            ? "entry"
            : operation === "resolve_containing_procedure"
              ? {
                  query_address: "0x401001",
                  found: true,
                  procedure: {
                    address: "0x401000",
                    name: "entry",
                    classification: null,
                    body: { available: false, reason: "not recorded" },
                  },
                }
              : operation === "list_bookmarks"
                ? []
                : null;
        return ok(createAnalysisExecution(result, identity));
      },
      close: async () => ok(null),
    }));
    const server = createServer(
      { kind: "session", session },
      {
        environment: {
          ...process.env,
          REA_MCP_OUTPUT_SCHEMA_PROFILE: profile,
          REA_MCP_TOOL_FAMILIES: "session",
        },
      },
    );
    const client = new Client({ name: "context-input-error", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const definitions = new Map(
        (await client.listTools()).tools.map((tool) => [tool.name, tool]),
      );
      const contextDefinition = definitions.get("inspect_address_context");
      if (contextDefinition === undefined)
        throw new Error("inspect_address_context was not advertised");
      expect(
        (
          await client.callTool({
            name: "open_binary",
            arguments: { path: target, format: "dos-com" },
          })
        ).isError,
      ).not.toBe(true);
      const response = await client.callTool(
        {
          name: "inspect_address_context",
          arguments: { address: "0x401001", document: "fixture" },
        },
        { toolDefinition: contextDefinition },
      );
      expect(response.isError).not.toBe(true);
      const contract = SESSION_TOOL_CONTRACTS.find(
        (
          candidate,
        ): candidate is Extract<
          (typeof SESSION_TOOL_CONTRACTS)[number],
          { readonly name: "inspect_address_context" }
        > => candidate.name === "inspect_address_context",
      );
      if (contract === undefined)
        throw new Error("inspect_address_context contract is missing");
      const parsed = contract.outputSchema.parse(
        response.structuredContent,
      ).result;
      const expected = projectAnalysisError(inputFailure);
      expect(parsed.name).toEqual({ state: "available", value: "entry" });
      expect(parsed.procedure).toMatchObject({
        state: "available",
        value: { found: true, query_address: "0x401001" },
      });
      const rejected =
        rejectedOperation === "comment" ? parsed.comment : parsed.bookmarks;
      expect(rejected).toEqual({
        state: "unavailable",
        reason: expected.message,
        remediation: expected.remediation.action,
        error: expected,
      });
      if (rejectedOperation === "comment")
        expect(parsed.bookmarks).toEqual({ state: "available", value: [] });
      else expect(parsed.comment).toEqual({ state: "available", value: null });
      expect(parsed.inline_comment).toMatchObject({ state: "unavailable" });
      expect(parsed.inline_comment).not.toHaveProperty("error");
      expect(expected.details).toMatchObject({
        issues: [
          {
            path: [rejectedOperation === "comment" ? "address" : "document"],
            expected: "controlled-value",
          },
        ],
        diagnostics: { producer_fact: "retained" },
      });
      expect(Object.hasOwn(expected, "recovery")).toBe(!conforms);
    } finally {
      await client.close();
      await server.close();
    }
  },
);

it("does not demote an input refusal with incomplete cleanup into a local facet", async () => {
  const identity = { id: "fixture", name: "Fixture", version: "1" };
  const failure = new AnalysisInputError(
    "comment",
    {
      cleanup: { reason: "controlled failure", resources: ["owned-resource"] },
    },
    [{ path: ["address"], reason: "invalid_value" }],
  );
  const result = await inspectAddressContext(
    {
      execute: async (operation) =>
        operation === "comment"
          ? err(failure)
          : ok(createAnalysisExecution(null, identity)),
    },
    { address: "0x401001", document: "fixture" },
  );
  if (result.ok) throw new Error("expected incomplete cleanup");
  expect(result.error).toBe(failure);
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "cleanup_incomplete",
    details: { resources: ["owned-resource"] },
  });
});
