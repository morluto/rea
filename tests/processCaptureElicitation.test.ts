import { isInputRequiredResult } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import { BinarySession } from "../src/application/BinarySession.js";
import { PermissionAuthority } from "../src/application/PermissionAuthority.js";
import { createPermissionPolicy } from "../src/domain/permissionPolicy.js";
import { silentLogger } from "../src/logger.js";
import { createServer } from "../src/server/createServer.js";
import { observed } from "./fixtures/analysisExecution.js";
import {
  authorizeProcessCaptureWithElicitation,
  PROCESS_CAPTURE_ELICITATION_POLICY,
  type ProcessCaptureElicitationState,
} from "../src/server/ProcessCaptureElicitation.js";

const request = {
  capability: "process_capture" as const,
  roots: ["/tmp"],
  executables: [process.execPath],
  environment_names: ["PATH"],
  network: "external" as const,
  mount: false,
  operation_identity: "capture:test",
};
const now = Date.parse("2026-07-18T00:00:00.000Z");

describe("process-capture MCP elicitation", () => {
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
    const session = new BinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const createTestServer = () =>
      createServer(session, session, {
        logger: silentLogger,
        permissionAuthority: authority,
        processPolicy: {
          enabled: true,
          executableRoots: [dirname(process.execPath)],
          workingRoots: [root],
          allowedEnvironment: [],
          allowExternalNetwork: true,
        },
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
  });

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
      const session = new BinarySession(() => ({
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
            processPolicy: {
              enabled: true,
              executableRoots: [dirname(process.execPath)],
              workingRoots: [root],
              allowedEnvironment: [],
              allowExternalNetwork: true,
            },
          }),
        { transport: serverTransport, legacy: "reject" },
      );
      const call = {
        name: "capture_process_scenario",
        arguments: {
          approved: true,
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
              (PROCESS_CAPTURE_ELICITATION_POLICY.stateTtlSeconds + 1) * 1_000,
          );
        const echoedState =
          failure === "tampered"
            ? `${requestState.slice(0, -1)}${requestState.endsWith("A") ? "B" : "A"}`
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
          code: -32_602,
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
  );

  it("grants and reuses a signed session scope on the modern protocol", async () => {
    const authority = ceilingOnlyAuthority();
    let state: ProcessCaptureElicitationState | undefined;
    const elicitation = {
      stateCodec: {
        mint: (value: ProcessCaptureElicitationState) => {
          state = value;
          return Promise.resolve("signed-state");
        },
        verify: () => verifiedState(state),
      },
      supported: () => true,
      now: () => now,
      consumedNonces: new Map<string, number>(),
    };
    const first = await authorizeProcessCaptureWithElicitation(
      authority,
      request,
      requestContext(),
      elicitation,
    );
    expect(isInputRequiredResult(first)).toBe(true);
    expect(first).toMatchObject({ requestState: "signed-state" });
    expect(first).toMatchObject({
      inputRequests: {
        process_capture_grant: {
          params: {
            message: expect.stringContaining("Mount access: no"),
          },
        },
      },
    });
    expect(state?.request).toEqual(request);

    const accepted = await authorizeProcessCaptureWithElicitation(
      authority,
      request,
      requestContext(state, {
        action: "accept",
        content: { lifetime: "session" },
      }),
      elicitation,
    );
    expect(isInputRequiredResult(accepted)).toBe(false);
    if (isInputRequiredResult(accepted)) return;
    expect(accepted.ok).toBe(true);

    const reused = await authorizeProcessCaptureWithElicitation(
      authority,
      request,
      requestContext(),
      elicitation,
    );
    expect(isInputRequiredResult(reused)).toBe(false);
    if (!isInputRequiredResult(reused)) expect(reused.ok).toBe(true);
  });

  it("fails closed for legacy clients and altered continuations", async () => {
    const authority = ceilingOnlyAuthority();
    let state: ProcessCaptureElicitationState | undefined;
    const elicitation = {
      stateCodec: {
        mint: (value: ProcessCaptureElicitationState) => {
          state = value;
          return Promise.resolve("signed-state");
        },
        verify: () => verifiedState(state),
      },
      supported: () => false,
      now: () => now,
      consumedNonces: new Map<string, number>(),
    };
    const legacy = await authorizeProcessCaptureWithElicitation(
      authority,
      request,
      requestContext(),
      elicitation,
    );
    expect(isInputRequiredResult(legacy)).toBe(false);
    if (!isInputRequiredResult(legacy)) expect(legacy.ok).toBe(false);

    const modern = { ...elicitation, supported: () => true };
    await authorizeProcessCaptureWithElicitation(
      authority,
      request,
      requestContext(),
      modern,
    );
    const altered = await authorizeProcessCaptureWithElicitation(
      authority,
      { ...request, operation_identity: "capture:altered" },
      requestContext(state, {
        action: "accept",
        content: { lifetime: "session" },
      }),
      modern,
    );
    expect(isInputRequiredResult(altered)).toBe(false);
    if (!isInputRequiredResult(altered)) expect(altered.ok).toBe(false);
  });

  it("binds signed continuation state to exact origins", async () => {
    const authority = ceilingOnlyAuthority([
      "https://example.test",
      "https://other.test",
    ]);
    let state: ProcessCaptureElicitationState | undefined;
    const elicitation = {
      stateCodec: {
        mint: (value: ProcessCaptureElicitationState) => {
          state = value;
          return Promise.resolve("signed-state");
        },
        verify: () => verifiedState(state),
      },
      supported: () => true,
      now: () => now,
      consumedNonces: new Map<string, number>(),
    };
    const scoped = { ...request, origins: ["https://example.test"] };
    const prompted = await authorizeProcessCaptureWithElicitation(
      authority,
      scoped,
      requestContext(),
      elicitation,
    );
    expect(prompted).toMatchObject({
      inputRequests: {
        process_capture_grant: {
          params: {
            message: expect.stringContaining("Origins: https://example.test"),
          },
        },
      },
    });

    const altered = await authorizeProcessCaptureWithElicitation(
      authority,
      { ...scoped, origins: ["https://other.test"] },
      requestContext(state, {
        action: "accept",
        content: { lifetime: "session" },
      }),
      elicitation,
    );

    expect(isInputRequiredResult(altered)).toBe(false);
    if (!isInputRequiredResult(altered)) expect(altered.ok).toBe(false);
  });

  it("consumes once grants and rejects continuation replay", async () => {
    const authority = ceilingOnlyAuthority();
    let state: ProcessCaptureElicitationState | undefined;
    const elicitation = {
      stateCodec: {
        mint: (value: ProcessCaptureElicitationState) => {
          state = value;
          return Promise.resolve("signed-state");
        },
        verify: () => verifiedState(state),
      },
      supported: () => true,
      now: () => now,
      consumedNonces: new Map<string, number>(),
    };
    await authorizeProcessCaptureWithElicitation(
      authority,
      request,
      requestContext(),
      elicitation,
    );
    const response = {
      action: "accept",
      content: { lifetime: "once" },
    };
    const accepted = await authorizeProcessCaptureWithElicitation(
      authority,
      request,
      requestContext(state, response),
      elicitation,
    );
    if (isInputRequiredResult(accepted)) throw new Error("grant was not used");
    expect(accepted.ok).toBe(true);

    const replayed = await authorizeProcessCaptureWithElicitation(
      authority,
      request,
      requestContext(state, response),
      elicitation,
    );
    expect(isInputRequiredResult(replayed)).toBe(false);
    if (!isInputRequiredResult(replayed)) expect(replayed.ok).toBe(false);

    const next = await authorizeProcessCaptureWithElicitation(
      authority,
      request,
      requestContext(),
      elicitation,
    );
    expect(isInputRequiredResult(next)).toBe(true);

    const declined = await authorizeProcessCaptureWithElicitation(
      authority,
      request,
      requestContext(state, { action: "decline" }),
      elicitation,
    );
    expect(isInputRequiredResult(declined)).toBe(false);
    const acceptedAfterDecline = await authorizeProcessCaptureWithElicitation(
      authority,
      request,
      requestContext(state, {
        action: "accept",
        content: { lifetime: "session" },
      }),
      elicitation,
    );
    expect(isInputRequiredResult(acceptedAfterDecline)).toBe(false);
    if (!isInputRequiredResult(acceptedAfterDecline))
      expect(acceptedAfterDecline.ok).toBe(false);
  });

  it("bounds replay state and prunes entries at the signed-state TTL", async () => {
    const authority = ceilingOnlyAuthority();
    let state: ProcessCaptureElicitationState | undefined;
    const consumedNonces = new Map<string, number>();
    const elicitation = {
      stateCodec: {
        mint: (value: ProcessCaptureElicitationState) => {
          state = value;
          return Promise.resolve("signed-state");
        },
        verify: () => verifiedState(state),
      },
      supported: () => true,
      now: () => now,
      consumedNonces,
    };
    await authorizeProcessCaptureWithElicitation(
      authority,
      request,
      requestContext(),
      elicitation,
    );
    const future = now + 600_000;
    for (let index = 0; index < 4_096; index += 1)
      consumedNonces.set(`occupied-${String(index)}`, future);

    const rejectedAtCapacity = await authorizeProcessCaptureWithElicitation(
      authority,
      request,
      requestContext(state, {
        action: "accept",
        content: { lifetime: "session" },
      }),
      elicitation,
    );
    expect(isInputRequiredResult(rejectedAtCapacity)).toBe(false);
    if (!isInputRequiredResult(rejectedAtCapacity))
      expect(rejectedAtCapacity.ok).toBe(false);

    consumedNonces.set("occupied-0", now - 1);
    const acceptedAfterPrune = await authorizeProcessCaptureWithElicitation(
      authority,
      request,
      requestContext(state, {
        action: "accept",
        content: { lifetime: "session" },
      }),
      elicitation,
    );
    expect(isInputRequiredResult(acceptedAfterPrune)).toBe(false);
    if (!isInputRequiredResult(acceptedAfterPrune))
      expect(acceptedAfterPrune.ok).toBe(true);
    expect(consumedNonces.has("occupied-0")).toBe(false);
    expect(consumedNonces.size).toBe(4_096);
  });

  it.each(["result", "throw"] as const)(
    "revokes an elicited grant when final authorization ends with %s",
    async (failure) => {
      const root = await createTestTempDirectory("rea-elicit-rollback-");
      const scoped = { ...request, roots: [root] };
      const policy = createPermissionPolicy([
        {
          capability: "process_capture",
          roots: scoped.roots,
          executables: scoped.executables,
          environment_names: scoped.environment_names,
          network: scoped.network,
          mount: scoped.mount,
        },
      ]);
      class FailingFinalAuthority extends PermissionAuthority {
        private authorizationCount = 0;

        override async authorize(
          ...arguments_: Parameters<PermissionAuthority["authorize"]>
        ): ReturnType<PermissionAuthority["authorize"]> {
          this.authorizationCount += 1;
          const result = await super.authorize(...arguments_);
          if (failure === "result" && this.authorizationCount === 2)
            await rm(root, { recursive: true, force: true });
          if (failure === "throw" && this.authorizationCount === 3)
            throw new Error("synthetic final authorization rejection");
          return result;
        }
      }
      const authority = new FailingFinalAuthority(policy);
      let state: ProcessCaptureElicitationState | undefined;
      const elicitation = {
        stateCodec: {
          mint: (value: ProcessCaptureElicitationState) => {
            state = value;
            return Promise.resolve("signed-state");
          },
          verify: () => verifiedState(state),
        },
        supported: () => true,
        now: () => now,
        consumedNonces: new Map<string, number>(),
      };
      await authorizeProcessCaptureWithElicitation(
        authority,
        scoped,
        requestContext(),
        elicitation,
      );
      const finalAuthorization = authorizeProcessCaptureWithElicitation(
        authority,
        scoped,
        requestContext(state, {
          action: "accept",
          content: { lifetime: "session" },
        }),
        elicitation,
      );
      if (failure === "throw")
        await expect(finalAuthorization).rejects.toThrow(
          "synthetic final authorization rejection",
        );
      else {
        const failed = await finalAuthorization;
        expect(isInputRequiredResult(failed)).toBe(false);
        if (!isInputRequiredResult(failed)) expect(failed.ok).toBe(false);
        await mkdir(root);
      }
      const retry = await authority.authorize(scoped, "read", {
        elicitationSupported: true,
      });
      expect(retry.ok).toBe(false);
    },
  );
});

const ceilingOnlyAuthority = (
  origins?: readonly string[],
): PermissionAuthority =>
  new PermissionAuthority(
    createPermissionPolicy([
      {
        capability: "process_capture",
        roots: request.roots,
        executables: request.executables,
        environment_names: request.environment_names,
        ...(origins === undefined ? {} : { origins }),
        network: request.network,
        mount: request.mount,
      },
    ]),
  );

const requestContext = (
  state?: ProcessCaptureElicitationState,
  response?: Record<string, unknown>,
) => ({
  mcpReq: {
    requestState: () => state,
    ...(response === undefined
      ? {}
      : { inputResponses: { process_capture_grant: response } }),
  },
});

const verifiedState = (
  state: ProcessCaptureElicitationState | undefined,
): Promise<ProcessCaptureElicitationState> => {
  if (state === undefined) throw new Error("state was not minted");
  return Promise.resolve(state);
};
