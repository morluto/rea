import { isInputRequiredResult } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { PermissionAuthority } from "../../../src/application/PermissionAuthority.js";
import { createPermissionPolicy } from "../../../src/domain/permissionPolicy.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { PROCESS_CAPTURE_ELICITATION_POLICY } from "../../../src/server/ProcessCaptureElicitation.js";

describe("process-capture MCP elicitation handshake: consent", () => {
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
    const session = createTestBinarySession(() => ({
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
      const status = await client.callTool({
        name: "binary_session",
        arguments: {},
      });
      expect(status.structuredContent).toMatchObject({
        result: {
          server_identity: {
            client: { name: "process-elicit", version: "1" },
          },
          client_features: {
            elicitation_form: true,
            elicitation_url: false,
            roots: false,
            sampling: false,
          },
        },
      });
      const captured = await client.callTool({
        name: "capture_process_scenario",
        arguments: {
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

describe("process-capture MCP elicitation handshake: legacy transport", () => {
  it.each(["tampered", "expired"] as const)(
    "rejects %s signed state through the modern MCP client and server",
    async (failure) => {
      const startedAt = Date.parse("2026-07-23T00:00:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(startedAt);
      const root = await createTestTempDirectory("rea-elicit-state-");
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
      const session = createTestBinarySession(() => ({
        execute: () => Promise.resolve(observed(null)),
        close: () => Promise.resolve(),
      }));
      const client = new Client(
        { name: "process-elicit-state", version: "1" },
        {
          capabilities: { elicitation: { form: {} } },
          versionNegotiation: {
            mode: {
              pin: PROCESS_CAPTURE_ELICITATION_POLICY.protocolVersions[0],
            },
          },
          inputRequired: { autoFulfill: false, maxRounds: 3 },
        },
      );
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const server = serveStdio(
        () =>
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
          }),
        { transport: serverTransport, legacy: "reject" },
      );
      const call = {
        name: "capture_process_scenario",
        arguments: {
          executable: process.execPath,
          arguments: ["-e", "process.exit(0)"],
          working_directory: root,
        },
      };
      try {
        await client.connect(clientTransport);
        const required = await client.callTool(call, {
          allowInputRequired: true,
        });
        expect(isInputRequiredResult(required)).toBe(true);
        if (!isInputRequiredResult(required)) return;
        const requestState = required.requestState;
        expect(requestState).toEqual(expect.any(String));
        if (requestState === undefined) return;
        if (failure === "expired")
          vi.setSystemTime(
            startedAt +
              (PROCESS_CAPTURE_ELICITATION_POLICY.stateTtlSeconds + 1) * 1000,
          );
        const echoedState =
          failure === "tampered"
            ? `${requestState.startsWith("A") ? "B" : "A"}${requestState.slice(1)}`
            : requestState;
        const retryMethod: string = "tools/call";
        await expect(
          client.request(
            {
              method: retryMethod,
              params: {
                ...call,
                requestState: echoedState,
                inputResponses: {
                  process_capture_grant: {
                    action: "accept",
                    content: { lifetime: "session" },
                  },
                },
              },
            },
            z.unknown(),
          ),
        ).rejects.toMatchObject({
          code: -32602,
          data: { reason: "invalid_request_state" },
        });
        expect(
          await authority.authorize(
            {
              capability: "process_capture",
              roots: [root],
              executables: [process.execPath],
              environment_names: [],
              network: "external",
              mount: false,
              operation_identity: `capture_process_scenario:${process.execPath}`,
            },
            "read",
          ),
        ).toMatchObject({ ok: false });
      } finally {
        await Promise.allSettled([client.close(), server.close()]);
        await rm(root, { recursive: true, force: true });
        vi.useRealTimers();
      }
    },
    20000,
  );
});
