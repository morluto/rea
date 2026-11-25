import type { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { expandToolAvailability } from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  component,
  externName,
  representativeComponent,
  section,
  u32,
  vec,
  vecOf,
} from "../../../src/wasm/WasmComponentBinary.fixture.js";
import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

const componentMcpTest = mcpTest.extend<{
  wasm: {
    client: Client;
    session: ReturnType<typeof createTestBinarySession>;
  };
}>({
  wasm: async ({ mcp }, use) => {
    const session = createTestBinarySession(() => {
      throw new Error("Component decoding must not start a deep provider");
    });
    try {
      const client = await mcp.connect(
        createServer({ kind: "session", session }),
      );
      await use({ client, session });
    } finally {
      await session.close();
    }
  },
});

componentMcpTest(
  "advertises valid schemas and decodes a component through MCP without an active target",
  async ({ wasm: { client, session } }) => {
    const status = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    expect(
      expandToolAvailability(
        toolContract("binary_session").outputSchema.parse(
          status.structuredContent,
        ).result.tool_availability,
      ),
    ).toContainEqual(
      expect.objectContaining({
        name: "inspect_wasm_component",
        available: true,
        reason: "available",
      }),
    );
    const { ajv, canonicalInputSchema, outputSchema, toolDefinition } =
      await advertisedMcpToolSchemas(client, "inspect_wasm_component");
    expect(
      ajv.validate(canonicalInputSchema, {
        path: "/artifacts/c.wasm",
        execute: true,
      }),
    ).toBe(false);
    expect(toolDefinition.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    const root = await createTestTempDirectory("rea-wasm-component-mcp-");
    const path = join(root, "component.wasm");
    await writeFile(path, representativeComponent());
    const response = await client.callTool({
      name: "inspect_wasm_component",
      arguments: { path },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    expect(
      ajv.validate(outputSchema, response.structuredContent),
      JSON.stringify(ajv.errors),
    ).toBe(true);
    const parsed = toolContract("inspect_wasm_component").outputSchema.parse(
      response.structuredContent,
    );
    const evidence = parseEvidence(parsed);
    expect(evidence.confidence).toBe("observed");
    expect(parsed.normalized_result).toMatchObject({
      validation: "not_performed",
      coverage: { status: "complete", not_decoded: [] },
      components: [
        {
          lifts: [
            {
              exported_as: ["run"],
              core_source: { name: "run", declared_by_module: true },
            },
          ],
          lowers: [
            { component_source: { kind: "import", name: "log" } },
            {
              component_source: {
                kind: "instance-export",
                instance_import: "wasi:fs/types@0.2.0",
              },
            },
          ],
        },
      ],
    });
    expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  },
);

componentMcpTest(
  "reports core modules, malformed components, oversized results and relative paths as typed MCP errors",
  async ({ wasm: { client } }) => {
    const root = await createTestTempDirectory("rea-wasm-component-mcp-err-");
    const core = join(root, "core.wasm");
    await writeFile(core, Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    const malformed = join(root, "malformed.wasm");
    const malformedBytes = Buffer.from(component([0x07, 0x05, 0x00]));
    await writeFile(malformed, malformedBytes);

    const unsupported = await client.callTool({
      name: "inspect_wasm_component",
      arguments: { path: core },
    });
    expect(unsupported.isError).toBe(true);
    expect(parseMcpToolError(unsupported)).toMatchObject({
      error: {
        code: "unsupported_target",
        details: { operation: "inspect_wasm_component", path: core },
        remediation: {
          action: expect.stringContaining("inspect_wasm_artifact"),
        },
      },
    });

    const invalid = await client.callTool({
      name: "inspect_wasm_component",
      arguments: { path: malformed },
    });
    expect(parseMcpToolError(invalid)).toMatchObject({
      error: {
        code: "unsupported_target",
        message: expect.stringContaining("at offset 10"),
        details: {
          operation: "inspect_wasm_component",
          failure_kind: "malformed",
          partial_observation: {
            kind: "file-snapshot-hash",
            path: malformed,
            sha256: createHash("sha256").update(malformedBytes).digest("hex"),
            bytes: malformedBytes.length,
          },
        },
      },
    });

    // One 1 MiB import name repeated by 1,000 lowers would serialize to 1 GiB.
    const repeated = join(root, "repeated.wasm");
    await writeFile(
      repeated,
      component(
        section(10, vec([...externName("f".repeat(1 << 20)), 0x01, ...u32(0)])),
        section(
          8,
          vecOf(Array.from({ length: 1_000 }, () => [0x01, 0x00, 0x00, 0x00])),
        ),
      ),
    );
    const oversized = await client.callTool({
      name: "inspect_wasm_component",
      arguments: { path: repeated },
    });
    expect(parseMcpToolError(oversized)).toMatchObject({
      error: {
        code: "resource_constraint",
        details: {
          resource: "transport",
          reported_limits: { maximum_output_bytes: 8 * 1024 * 1024 },
        },
      },
    });

    const partial = join(root, "partial.wasm");
    await writeFile(partial, component(section(13, [0x00])));
    const decoded = await client.callTool({
      name: "inspect_wasm_component",
      arguments: { path: partial },
    });
    expect(
      toolContract("inspect_wasm_component").outputSchema.parse(
        decoded.structuredContent,
      ).normalized_result.coverage,
    ).toEqual({
      status: "partial",
      not_decoded: [
        {
          component: 0,
          range: { start: 10, end: 11 },
          kind: "unsupported",
          reason: "Unknown section id 13 at offset 10",
        },
      ],
    });

    const relative = await client.callTool({
      name: "inspect_wasm_component",
      arguments: { path: "relative.wasm" },
    });
    expect(parseMcpToolError(relative)).toMatchObject({
      error: { code: "invalid_request" },
    });
  },
);
