import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createSolanaToolServices } from "../../../src/composition/solana.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import type { SolanaProgramAnalysis } from "../../../src/domain/solana/solanaProgram.js";
import { sha256Hex } from "../../../src/kernel/sha256Hex.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { solanaDispatchElf } from "../../fixtures/solana/elf.js";
import { ownArtifactSession } from "../../support/mcp/artifactSession.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

mcpTest(
  "records Solana program evidence through MCP without a binary target and refuses a non-empty out_dir",
  async ({ mcp, onTestFinished, expect }) => {
    const root = await createTestTempDirectory("rea-solana-mcp-");
    const elf = solanaDispatchElf();
    const elfPath = join(root, "program.so");
    await writeFile(elfPath, elf);
    const session = createTestBinarySession(() => {
      throw new Error("deep provider must not start");
    });
    const server = createServer(
      { kind: "session", session },
      { solanaProgram: createSolanaToolServices({}) },
    );
    ownArtifactSession(session, onTestFinished);
    const client = await mcp.connect(server, {
      name: "solana-program-contract",
      version: "1",
    });

    const outDir = join(root, "out");
    const response = await client.callTool({
      name: "analyze_solana_program",
      arguments: {
        path: elfPath,
        out_dir: outDir,
        instruction_names: ["create_config"],
      },
    });
    expect(response.isError).not.toBe(true);
    const evidence = parseEvidence(
      toolContract("analyze_solana_program").outputSchema.parse(
        response.structuredContent,
      ),
    );
    expect(evidence.confidence).toBe("inferred");
    const analysis = evidence.normalized_result as SolanaProgramAnalysis;
    expect(analysis.artifact.sha256).toBe(sha256Hex(elf));
    expect(analysis.handlers.map((handler) => handler.name)).toEqual([
      "create_config",
    ]);
    expect((await readdir(outDir)).sort()).toEqual([
      "disassembly.txt",
      "solana-analysis.json",
    ]);

    const again = await client.callTool({
      name: "analyze_solana_program",
      arguments: { path: elfPath, out_dir: outDir },
    });
    expect(again.isError).toBe(true);
    expect((await readdir(outDir)).sort()).toEqual([
      "disassembly.txt",
      "solana-analysis.json",
    ]);
  },
);
