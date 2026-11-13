import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { AnalysisProviderRegistry } from "../../../../src/application/binary/AnalysisProviderRegistry.js";
import { offeredOperationAlternatives } from "../../../../src/application/OperationAlternatives.js";
import { composeBinarySession } from "../../../../src/application/binary/BinarySessionComposition.js";
import { toolContract } from "../../../../src/contracts/toolContracts.js";
import { expandToolAvailability } from "../../../../src/contracts/toolOutputSchemaPrimitives.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import { KunaProvider } from "../../../../src/kuna/KunaProvider.js";
import { elfNoteFixture } from "../../../../src/native/elf/ElfNotes.fixture.js";
import { createServer } from "../../../../src/server/createServer.js";
import { parseMcpToolError } from "../../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../../support/mcp/mcpFixture.js";
import { writeFakeKuna } from "./fakeKuna.js";
import { FUNCTIONS } from "./kunaSessionFixture.js";

const test = mcpTest.skipIf(process.platform === "win32");

test("names only Kuna's assembly text for navigation refusals in a scoped catalog", async ({
  mcp,
}) => {
  const root = await createTestTempDirectory("rea-kuna-navigation-mcp-");
  const kuna = await writeFakeKuna(root, { functions: FUNCTIONS });
  const target = join(root, "program");
  await writeFile(target, elfNoteFixture({ bits: 64, type: 2 }));
  const session = composeBinarySession(
    new AnalysisProviderRegistry(
      [
        new KunaProvider(
          { REA_KUNA_COMMAND: kuna, REA_KUNA_CACHE_DIR: join(root, "cache") },
          { platform: process.platform },
        ),
      ],
      "kuna",
    ),
  );
  try {
    const client = await mcp.connect(
      createServer(
        { kind: "session", session },
        { environment: { REA_MCP_TOOL_FAMILIES: "session,direct" } },
      ),
    );
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: target },
    });
    expect(opened.isError).not.toBe(true);

    for (const name of ["next_address", "prev_address"]) {
      const { error } = parseMcpToolError(
        await client.callTool({ name, arguments: { address: "0x1000" } }),
      );
      expect(error).toMatchObject({
        code: "capability_unavailable",
        category: "unsupported_provider",
        retryable: false,
        remediation: {
          action: offeredOperationAlternatives(
            name,
            (alternative) => alternative === "procedure_assembly",
          )?.remediation,
        },
        details: {
          provider_id: "kuna",
          operation: name,
          alternatives: ["procedure_assembly"],
        },
      });
    }

    const status = toolContract("binary_session").outputSchema.parse(
      (
        await client.callTool({
          name: "binary_session",
          arguments: { detail: "complete" },
        })
      ).structuredContent,
    ).result;
    const tools = expandToolAvailability(status.tool_availability);
    for (const name of ["next_address", "prev_address"])
      expect(tools).toContainEqual(
        expect.objectContaining({
          name,
          reason: "provider_missing",
          alternatives: ["procedure_assembly"],
        }),
      );
    // The structured reads stay unavailable and are not offered.
    for (const name of [
      "inspect_native_instruction",
      "read_function_instructions",
    ])
      expect(tools).toContainEqual(
        expect.objectContaining({ name, available: false }),
      );

    // The offered follow-up works on the same connection.
    const assembly = await client.callTool({
      name: "procedure_assembly",
      arguments: { procedure: "main" },
    });
    expect(assembly.isError).not.toBe(true);
    expect(parseEvidence(assembly.structuredContent).provider.id).toBe("kuna");
  } finally {
    await mcp.close();
    expect(await session.close()).toEqual({ ok: true, value: null });
  }
}, 60_000);
