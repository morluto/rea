import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../../src/server/createServer.js";
import { createTestBinarySession } from "../fixtures/binarySession.js";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";
import { ByteEntropyService } from "../../src/application/binaryDiagnostics/ByteEntropyService.js";
import { parseEvidence } from "../../src/domain/evidence.js";

describe.skipIf(process.platform !== "win32")(
  "Windows selected-file spelling",
  () => {
    cliTest(
      "shares entropy identity across service/MCP admission and CLI case spellings",
      async ({ cli }) => {
        const root = await realpath(
          await createTestTempDirectory("rea-EntropyCase-"),
        );
        const path = join(root, "Sample.BIN");
        await writeFile(path, Buffer.from([1, 2, 3, 4]));
        const service = new ByteEntropyService();
        const session = createTestBinarySession(() => {
          throw new Error("No analysis provider should start");
        });
        const server = createServer({ kind: "session", session });
        const client = new Client({ name: "entropy-case", version: "1" });
        const [clientTransport, serverTransport] =
          InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        try {
          const ids = new Set<string>();
          for (const spelling of [
            path,
            path.toUpperCase(),
            path.toLowerCase(),
            path.replaceAll("\\", "/"),
            `${root}\\.\\Sample.BIN`,
          ]) {
            const direct = await service.inspect({ path: spelling });
            if (!direct.ok) throw direct.error;
            const fromCli = await cli.run({
              arguments: ["inspect-byte-entropy", spelling, "--json"],
            });
            expect(fromCli.exitCode, fromCli.stderr).toBe(0);
            const evidence = parseEvidence(fromCli.json);
            const response = await client.callTool({
              name: "inspect_byte_entropy",
              arguments: { path: spelling },
            });
            expect(response.isError).not.toBe(true);
            const mcpEvidence = parseEvidence(response.structuredContent);
            ids.add(mcpEvidence.evidence_id);
            expect(mcpEvidence.caller_input_path).toBe(spelling);
            ids.add(evidence.evidence_id);
            ids.add(direct.value.evidence_id);
            expect(direct.value.caller_input_path).toBe(spelling);
            expect(evidence.caller_input_path).toBe(spelling);
          }
          expect(ids.size).toBe(1);
        } finally {
          await client.close();
          await server.close();
          await session.close();
          await service.close();
        }
      },
    );
  },
);
