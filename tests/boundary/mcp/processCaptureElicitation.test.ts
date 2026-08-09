import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { composeBinarySessionFromFactory } from "../../../src/application/BinarySessionComposition.js";
import { PermissionAuthority } from "../../../src/application/PermissionAuthority.js";
import { createPermissionPolicy } from "../../../src/domain/permissionPolicy.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { PROCESS_CAPTURE_ELICITATION_POLICY } from "../../../src/server/ProcessCaptureElicitation.js";
describe("process-capture MCP elicitation handshake", () => {
  it("completes signed consent through the modern MCP client and server", async () => {
    const root = await createTestTempDirectory("rea-elicit-mcp-");
    const authority = new PermissionAuthority(
      createPermissionPolicy([
        {
          capability: "process_capture",
          roots: [root],
          executables: [process.execPath],
          environment_names: [],
          network: "external",
          mount: false,
        },
      ]),
    );
    const session = composeBinarySessionFromFactory(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const createTestServer = () =>
      createServer(session, session, {
        logger: silentLogger,
        permissionAuthority: authority,
        processPolicy: () => ({
          status: "enabled",
          executableRoots: [dirname(process.execPath)],
          workingRoots: [root],
          allowedEnvironment: [],
          networkAccess: "external",
        }),
      });
    const client = new Client(
      { name: "process-elicit", version: "1" },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: {
          mode: {
            pin: PROCESS_CAPTURE_ELICITATION_POLICY.protocolVersions[0],
          },
        },
        inputRequired: { autoFulfill: true, maxRounds: 3 },
      },
    );
    let prompts = 0;
    client.setRequestHandler("elicitation/create", () => {
      prompts += 1;
      return Promise.resolve({
        action: "accept" as const,
        content: { lifetime: "session" },
      });
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = serveStdio(createTestServer, {
      transport: serverTransport,
      legacy: "reject",
    });
    try {
      await client.connect(clientTransport);
      const captured = await client.callTool({
        name: "capture_process_scenario",
        arguments: {
          approved: true,
          executable: process.execPath,
          arguments: ["-e", "process.exit(0)"],
          working_directory: root,
        },
      });
      expect(captured.isError).not.toBe(true);
      expect(prompts).toBe(1);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
});
