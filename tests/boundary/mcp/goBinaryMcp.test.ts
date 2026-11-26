import { fileIdentity } from "../../fixtures/evidenceSubject.js";
import {
  canonicalOutputSchema,
  withCanonicalOutputSchema,
} from "../../fixtures/canonicalOutputSchema.js";
import { goBinarySchema } from "../../../src/domain/go/goBinary.js";
import type { Client } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { phaseArrival, phaseGate } from "../../support/lifecycleHarness.js";
import { withVerifierCleanup } from "../../../scripts/lib/verifier-cleanup.mjs";
import { readAnalysisSnapshot } from "../../../src/application/binary/AnalysisSnapshotFiles.js";
import { GoBinaryService } from "../../../src/application/go/GoBinaryService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  evidenceResultOf,
  expandToolAvailability,
} from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { GoBinaryProvider } from "../../../src/go/GoBinaryProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import {
  createGoBinaryByteStringFixture,
  createGoBinaryDiagnosticFixtures,
  createGoBinaryFixture,
  createGoBinaryOneDirectoryFixture,
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
    await withVerifierCleanup(async () => {
      const client = await mcp.connect(
        createServer({ kind: "session", session }),
      );
      await use({ client, session });
    }, [
      async () => {
        const closed = await session.close();
        if (!closed.ok) throw closed.error;
      },
    ]);
  },
});

mcpTest(
  "retains MIPS identity and in-flight Go inspection in the saved session snapshot",
  async ({ mcp }) => {
    const root = await createTestTempDirectory("rea-go-mcp-close-");
    const path = join(root, "application");
    const snapshotPath = join(root, "analysis.json");
    const fixture = createGoBinaryFixture({ bits: 32, byteOrder: "big" });
    fixture.bytes.writeUInt16BE(8, 18); // ELF EM_MIPS.
    await writeFile(path, fixture.bytes);
    const goInspection = phaseGate();
    const inspectionClose = phaseArrival();
    const provider = new GoBinaryProvider();
    const session = createTestBinarySession(createCacheProvider([]));
    const service = new GoBinaryService({
      close: () => provider.close(),
      identity: provider.identity,
      inspect: async (input, options) => {
        const result = await provider.inspect(input, options);
        await goInspection.hold();
        return result;
      },
    });
    let inspection: ReturnType<Client["callTool"]> | undefined;
    let closing: ReturnType<Client["callTool"]> | undefined;
    await withVerifierCleanup(async () => {
      const client = await mcp.connect(
        createServer({ kind: "session", session }, { goBinary: service }),
      );
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path },
      });
      expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
      client.setNotificationHandler("notifications/progress", () => {
        inspectionClose.arrive();
      });
      inspection = client.callTool({
        name: "inspect_go_binary",
        arguments: { path },
      });
      await goInspection.reached(inspection, "Go inspection");
      closing = client.callTool({
        name: "close_binary",
        arguments: { snapshot_path: snapshotPath },
        _meta: { progressToken: "go-close-race" },
      });
      await inspectionClose.reached(closing, "Go snapshot close");
      goInspection.release();
      const inspected = await inspection;
      expect(inspected.isError, JSON.stringify(inspected.content)).not.toBe(
        true,
      );
      const evidence = evidenceResultOf(goBinarySchema).parse(
        inspected.structuredContent,
      );
      expect(fileIdentity(evidence.subject).architecture).toBe("mips");
      expect(evidence.normalized_result).toMatchObject({
        architecture: "mips",
        bits: 32,
        byte_order: "big",
      });
      const closed = await closing;
      expect(closed.isError, JSON.stringify(closed.content)).not.toBe(true);
      const snapshot = await readAnalysisSnapshot(snapshotPath);
      if (!snapshot.ok) throw snapshot.error;
      expect(snapshot.value.evidence_bundle.records).toContainEqual(evidence);
      expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
      const reset = await client.callTool({
        name: "reset_investigation",
        arguments: {},
      });
      expect(reset.isError, JSON.stringify(reset.content)).not.toBe(true);
      expect(session.evidenceById(evidence.evidence_id)).toBeUndefined();
    }, [
      () => goInspection.release(),
      async () => {
        await Promise.allSettled([
          ...(inspection === undefined ? [] : [inspection]),
          ...(closing === undefined ? [] : [closing]),
        ]);
      },
      async () => {
        const closed = await session.close();
        if (!closed.ok) throw closed.error;
      },
    ]);
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

goMcpTest.skipIf(process.platform === "win32")(
  "suggests a resolved regular file after rejecting a selected symlink",
  async ({ go: { client } }) => {
    const root = await createTestTempDirectory("rea-go-mcp-symlink-");
    const original = join(root, "original.elf");
    const selected = join(root, "selected");
    await writeFile(original, createGoBinaryFixture().bytes);
    await symlink(original, selected);

    const rejected = await client.callTool({
      name: "inspect_go_binary",
      arguments: { path: selected },
    });
    const diagnostic = parseMcpToolError(rejected).error;
    expect(diagnostic).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [{ path: ["path"], reason: "invalid_format" }],
      },
      remediation: { action: expect.stringContaining(original) },
    });
    expect(diagnostic).not.toHaveProperty("recovery");

    const retried = await client.callTool({
      name: "inspect_go_binary",
      arguments: { path: original },
    });
    expect(retried.isError).not.toBe(true);
  },
);

for (const targetKind of ["dangling", "directory"] as const) {
  goMcpTest.skipIf(process.platform === "win32")(
    `keeps a ${targetKind} symlink rejection without a resolved-file hint`,
    async ({ go: { client } }) => {
      const root = await createTestTempDirectory("rea-go-mcp-symlink-");
      const target = join(root, "target");
      const selected = join(root, "selected");
      if (targetKind === "directory") await mkdir(target);
      await symlink(target, selected);

      const rejected = await client.callTool({
        name: "inspect_go_binary",
        arguments: { path: selected },
      });
      const diagnostic = parseMcpToolError(rejected).error;
      expect(diagnostic).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["path"],
              reason: "invalid_format",
              message: expect.stringContaining(selected),
            },
          ],
        },
      });
      expect(diagnostic.remediation.action).not.toContain(target);
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
    const evidence = evidenceResultOf(goBinarySchema).parse(
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
      expect(
        response.isError,
        `${fixture.name} returned a non-error result: ${JSON.stringify(response).slice(0, 2000)}`,
      ).toBe(true);
      expect(parseMcpToolError(response), fixture.name).toMatchObject({
        error: {
          code: fixture.code,
          details: {
            ...fixture.details,
            ...(fixture.code === "unsupported_target" ? { path } : {}),
          },
        },
      });
    }
    // A declared directory count below 16 is admitted, as the loader admits it.
    const path = join(root, "one-directory.exe");
    await writeFile(path, createGoBinaryOneDirectoryFixture().bytes);
    const admitted = await client.callTool({
      name: "inspect_go_binary",
      arguments: { path },
    });
    expect(admitted.isError, JSON.stringify(admitted.content)).not.toBe(true);
    expect(
      goBinarySchema.parse(
        (admitted.structuredContent as { normalized_result: unknown })
          .normalized_result,
      ).build_info,
    ).toMatchObject({ go_version: "go1.26.0" });
  },
);

goMcpTest(
  "advertises valid schemas and inspects real file bytes through MCP without an active target",
  async ({ go: { client, session } }) => {
    const status = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    const availability = expandToolAvailability(
      toolContract("binary_session").outputSchema.parse(
        status.structuredContent,
      ).result.tool_availability,
    );
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
    if (advertised === undefined)
      throw new Error("Go metadata must publish both schemas");
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const inputSchema: Record<string, unknown> = advertised.inputSchema;
    const outputSchema: Record<string, unknown> = canonicalOutputSchema(
      advertised.name,
    );
    expect(ajv.validateSchema(inputSchema)).toBe(true);
    expect(ajv.validateSchema(outputSchema)).toBe(true);
    expect(
      ajv.validate(inputSchema, { path: "/artifacts/program", execute: true }),
    ).toBe(false);
    expect(advertised.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    const nulPath = await client.callTool({
      name: "inspect_go_binary",
      arguments: { path: "/artifacts/\0program" },
    });
    expect(parseMcpToolError(nulPath)).toMatchObject({
      error: {
        code: "invalid_request",
        details: { issues: [{ path: ["path"], reason: "invalid_format" }] },
      },
    });
    const root = await createTestTempDirectory("rea-go-mcp-");
    const path = join(root, "application");
    const fixture = createGoBinaryFixture({
      moduleText: "path\texample.com/tool\nnew-record\tfuture\n",
    });
    await writeFile(path, fixture.bytes);
    const response = await client.callTool(
      { name: "inspect_go_binary", arguments: { path } },
      { toolDefinition: withCanonicalOutputSchema(advertised) },
    );
    expect(response.isError).not.toBe(true);
    const parsed = evidenceResultOf(goBinarySchema).parse(
      response.structuredContent,
    );
    const evidence = parseEvidence(parsed);
    expect(evidence.confidence).toBe("observed");
    expect(parsed.normalized_result.build_info?.module).toMatchObject({
      path: "example.com/tool",
      complete: false,
      unparsed_lines: ["new-record\tfuture"],
    });
    expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
    const invalid = await client.callTool({
      name: "inspect_go_binary",
      arguments: { path: "relative.bin" },
    });
    expect(parseMcpToolError(invalid)).toMatchObject({
      error: {
        code: "invalid_request",
        details: { issues: [{ path: ["path"], reason: "invalid_format" }] },
      },
    });
  },
);
