import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { buildUImage } from "../../fixtures/uimage.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";
import { createCli } from "../../../src/cli.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import type { Evidence } from "../../../src/domain/evidence.js";
import { FirmwareArchitectureCandidatesService } from "../../../src/application/binaryDiagnostics/FirmwareArchitectureCandidatesService.js";
import { FirmwareArchitectureCandidatesProvider } from "../../../src/firmware/architectureCandidates/FirmwareArchitectureCandidatesProvider.js";
import { silentLogger } from "../../../src/logger.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { registerServiceTools } from "../../../src/server/serviceToolBindings.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";

const createCandidatesMcpServer = (
  session: ReturnType<typeof createTestBinarySession>,
) => {
  const service = new FirmwareArchitectureCandidatesService(
    new FirmwareArchitectureCandidatesProvider(),
  );
  onTestFinished(() => service.close());
  const record = (evidence: Evidence) => session.recordEvidence(evidence);
  const lookup = (id: string) => session.evidenceById(id);
  const server = new EvidenceMcpServer(
    { name: "fw-arch-candidates-boundary", version: "1" },
    {},
    record,
    createToolResultDelivery(undefined),
  );
  registerServiceTools(
    server,
    { firmwareArchitectureCandidates: service },
    { logger: silentLogger, recordEvidence: record, evidenceById: lookup },
  );
  return server;
};

mcpTest(
  "executes inspect_firmware_architecture_candidates with CLI and advertised MCP parity",
  async ({ mcp }) => {
    const session = createTestBinarySession(() => {
      throw new Error(
        "Firmware architecture candidate scan must not start a deep provider",
      );
    });
    const client = await mcp.connect(createCandidatesMcpServer(session));
    const schemas = await advertisedMcpToolSchemas(
      client,
      "inspect_firmware_architecture_candidates",
    );

    const dir = await createTestTempDirectory("rea-fw-arch-mcp-cli-");
    const blobPath = join(dir, "kernel.uimage");
    await writeFile(
      blobPath,
      buildUImage({
        arch: 2, // arm
        compression: 0,
        loadAddress: 0x80008000,
        entryPoint: 0x80008000,
        payload: Buffer.alloc(64, 0x00),
      }),
    );

    const mcpResponse = await client.callTool(
      {
        name: "inspect_firmware_architecture_candidates",
        arguments: { path: blobPath },
      },
      { toolDefinition: schemas.toolDefinition },
    );
    expect(mcpResponse.isError, JSON.stringify(mcpResponse)).not.toBe(true);
    const mcpEvidence = toolContract(
      "inspect_firmware_architecture_candidates",
    ).outputSchema.parse(mcpResponse.structuredContent);
    expect(mcpEvidence.normalized_result.status).toBe("candidates_found");
    expect(mcpEvidence.normalized_result.candidates[0]).toMatchObject({
      cpu_family: "arm",
      detector: "uimage-header",
      confidence: "derived",
    });

    let stdout = "";
    let exitCode = 0;
    await createCli({}).serve(
      ["inspect-firmware-architecture-candidates", blobPath, "--json"],
      {
        env: {},
        exit: (code) => {
          exitCode = code;
        },
        stdout: (chunk) => {
          stdout += chunk;
        },
      },
    );
    expect(exitCode).toBe(0);
    const cliEvidence = toolContract(
      "inspect_firmware_architecture_candidates",
    ).outputSchema.parse(JSON.parse(stdout));
    expect(cliEvidence.normalized_result).toEqual(
      mcpEvidence.normalized_result,
    );

    const refused = await client.callTool(
      {
        name: "inspect_firmware_architecture_candidates",
        arguments: { path: blobPath, max_file_bytes: 32 },
      },
      { toolDefinition: schemas.toolDefinition },
    );
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain("max_file_bytes");
  },
);

it("returns typed resource and cancellation failures", async () => {
  const dir = await createTestTempDirectory("rea-fw-arch-lifecycle-");
  const blobPath = join(dir, "firmware.uimage");
  await writeFile(
    blobPath,
    buildUImage({
      arch: 2,
      compression: 0,
      loadAddress: 0x80008000,
      entryPoint: 0x80008000,
      payload: Buffer.alloc(64, 0),
    }),
  );

  const service = new FirmwareArchitectureCandidatesService(
    new FirmwareArchitectureCandidatesProvider(),
  );
  onTestFinished(() => service.close());

  const tooSmall = await service.inspect({
    path: blobPath,
    max_file_bytes: 32,
  });
  expect(tooSmall.ok).toBe(false);
  if (tooSmall.ok) return;
  expect(tooSmall.error).toMatchObject({
    _tag: "AnalysisResourceConstraintError",
    limit: {
      control_kind: "parameter",
      parameter: "max_file_bytes",
      effective_value: 32,
      applies_at: "next_call",
    },
  });

  const cancelled = await service.inspect(
    { path: blobPath },
    { signal: AbortSignal.abort("stop-scan") },
  );
  expect(cancelled.ok).toBe(false);
  if (cancelled.ok) return;
  expect(cancelled.error._tag).toBe("AnalysisCancelledError");
  expect(cancelled.error.cause).toBe("stop-scan");
});
