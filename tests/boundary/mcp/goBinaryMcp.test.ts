import type { Client } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { readAnalysisSnapshot } from "../../../src/application/binary/AnalysisSnapshotFiles.js";
import { GoBinaryService } from "../../../src/application/go/GoBinaryService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { toolAvailability } from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { GoBinaryProvider } from "../../../src/go/GoBinaryProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  createCacheProvider,
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import {
  createGoBinaryByteStringFixture,
  createGoBinaryDiagnosticFixtures,
  createGoBinaryFixture,
  createGoBinaryPathFailureFixture,
} from "../../fixtures/go/image.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

const goMcpTest = mcpTest.extend<{
  go: {
    client: Client;
    session: ReturnType<typeof createTestBinarySession>;
  };
}>({
  go: async ({ mcp }, use) => {
    const session = createTestBinarySession(() => {
      throw new Error("Go metadata must not start a deep provider");
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

mcpTest(
  "includes an in-flight Go inspection in the snapshot before closing its session",
  async ({ mcp }) => {
    const root = await createTestTempDirectory("rea-go-mcp-close-");
    const path = join(root, "application");
    const snapshotPath = join(root, "analysis.json");
    await writeFile(path, createGoBinaryFixture().bytes);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const closeStarted = createDeferred<void>();
    const provider = new GoBinaryProvider();
    const session = createTestBinarySession(createCacheProvider([]));
    const service = new GoBinaryService({
      identity: provider.identity,
      inspect: async (input, options) => {
        const result = await provider.inspect(input, options);
        entered.resolve();
        await release.promise;
        return result;
      },
    });
    try {
      const client = await mcp.connect(
        createServer({ kind: "session", session }, { goBinary: service }),
      );
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path },
      });
      expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
      client.setNotificationHandler("notifications/progress", () => {
        closeStarted.resolve();
      });
      const inspection = client.callTool({
        name: "inspect_go_binary",
        arguments: { path },
      });
      await entered.promise;
      const closing = client.callTool({
        name: "close_binary",
        arguments: { snapshot_path: snapshotPath },
        _meta: { progressToken: "go-close-race" },
      });
      await closeStarted.promise;
      release.resolve();
      const inspected = await inspection;
      expect(inspected.isError, JSON.stringify(inspected.content)).not.toBe(
        true,
      );
      const evidence = toolContract("inspect_go_binary").outputSchema.parse(
        inspected.structuredContent,
      );
      const closed = await closing;
      expect(closed.isError, JSON.stringify(closed.content)).not.toBe(true);
      const snapshot = await readAnalysisSnapshot(snapshotPath);
      if (!snapshot.ok) throw snapshot.error;
      expect(snapshot.value.evidence_bundle.records).toContainEqual(evidence);
      expect(session.evidenceById(evidence.evidence_id)).toBeUndefined();
    } finally {
      release.resolve();
      await session.close();
    }
  },
);

for (const expectedErrno of ["ELOOP", "ENAMETOOLONG"] as const) {
  goMcpTest.skipIf(expectedErrno === "ELOOP" && process.platform === "win32")(
    `reports native ${expectedErrno} path failure as invalid selected-path input through Go MCP`,
    async ({ go: { client } }) => {
      const root = await createTestTempDirectory("rea-go-mcp-path-failure-");
      const { path, errno } = await createGoBinaryPathFailureFixture(
        root,
        expectedErrno,
      );
      const response = await client.callTool({
        name: "inspect_go_binary",
        arguments: { path },
      });
      const diagnostic = parseMcpToolError(response);
      expect(diagnostic.error).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "inspect_go_binary",
          issues: [
            {
              path: ["path"],
              reason: "invalid_value",
              message: expect.stringContaining(errno),
            },
          ],
        },
      });
      expect(diagnostic.error.details).toMatchObject({
        issues: [{ message: expect.stringContaining(path) }],
      });
    },
  );
}

goMcpTest(
  "preserves invalid embedded Go text bytes through MCP",
  async ({ go: { client, session } }) => {
    const root = await createTestTempDirectory("rea-go-mcp-byte-strings-");
    const path = join(root, "byte-strings.elf");
    const fixture = createGoBinaryByteStringFixture();
    await writeFile(path, fixture.bytes);
    const response = await client.callTool({
      name: "inspect_go_binary",
      arguments: { path },
    });
    expect(response.isError).not.toBe(true);
    const evidence = toolContract("inspect_go_binary").outputSchema.parse(
      response.structuredContent,
    );
    expect(evidence.normalized_result.build_info).toEqual(
      fixture.expectedBuildInfo,
    );
    expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  },
);

goMcpTest(
  "distinguishes unsupported MZ carriers from malformed PE through MCP",
  async ({ go: { client } }) => {
    const root = await createTestTempDirectory("rea-go-mcp-mz-");
    for (const fixture of createGoBinaryDiagnosticFixtures()) {
      const path = join(root, `${fixture.name}.exe`);
      await writeFile(path, fixture.bytes);
      const response = await client.callTool({
        name: "inspect_go_binary",
        arguments: { path },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response)).toMatchObject({
        error: {
          code: fixture.code,
          details: {
            ...fixture.details,
            ...(fixture.code === "unsupported_target" ? { path } : {}),
          },
        },
      });
    }
  },
);

goMcpTest(
  "advertises valid schemas and inspects real file bytes through MCP without an active target",
  async ({ go: { client, session } }) => {
    const status = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    const availability = z
      .object({
        result: z.object({ tool_availability: z.array(toolAvailability) }),
      })
      .parse(status.structuredContent).result.tool_availability;
    expect(availability).toContainEqual(
      expect.objectContaining({
        name: "inspect_go_binary",
        available: true,
        reason: "available",
      }),
    );
    const advertised = (await client.listTools()).tools.find(
      (tool) => tool.name === "inspect_go_binary",
    );
    if (advertised?.outputSchema === undefined)
      throw new Error("Go metadata must publish both schemas");
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const inputSchema: Record<string, unknown> = advertised.inputSchema;
    const outputSchema: Record<string, unknown> = advertised.outputSchema;
    expect(ajv.validateSchema(inputSchema)).toBe(true);
    expect(ajv.validateSchema(outputSchema)).toBe(true);
    expect(
      ajv.validate(inputSchema, { path: "/artifacts/program", execute: true }),
    ).toBe(false);
    expect(ajv.validate(inputSchema, { path: "/artifacts/\0program" })).toBe(
      false,
    );
    expect(advertised.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    const root = await createTestTempDirectory("rea-go-mcp-");
    const path = join(root, "application");
    const fixture = createGoBinaryFixture({
      moduleText: "path\texample.com/tool\nnew-record\tfuture\n",
    });
    await writeFile(path, fixture.bytes);
    const response = await client.callTool({
      name: "inspect_go_binary",
      arguments: { path },
    });
    expect(response.isError).not.toBe(true);
    expect(
      ajv.validate(outputSchema, response.structuredContent),
      JSON.stringify(ajv.errors),
    ).toBe(true);
    const parsed = toolContract("inspect_go_binary").outputSchema.parse(
      response.structuredContent,
    );
    const evidence = parseEvidence(parsed);
    expect(evidence.confidence).toBe("observed");
    expect(parsed.normalized_result.build_info?.module).toMatchObject({
      path: "example.com/tool",
      complete: false,
      unparsed_lines: ["new-record\tfuture"],
    });
    expect(evidence.limitations.join(" ")).toContain(
      "could not be parsed completely",
    );
    expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
    const invalid = await client.callTool({
      name: "inspect_go_binary",
      arguments: { path: "relative.bin" },
    });
    expect(invalid.isError).toBe(true);
    expect(parseMcpToolError(invalid)).toMatchObject({
      error: {
        code: "invalid_request",
        details: { issues: [{ path: ["path"], reason: "invalid_format" }] },
      },
    });
  },
);
