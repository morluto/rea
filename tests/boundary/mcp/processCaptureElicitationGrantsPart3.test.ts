import { isInputRequiredResult } from "@modelcontextprotocol/server";
import { mkdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { PermissionAuthority } from "../../../src/application/PermissionAuthority.js";
import { createPermissionPolicy } from "../../../src/domain/permissionPolicy.js";
import {
  authorizeProcessCaptureWithElicitation,
  type ProcessCaptureElicitationState,
} from "../../../src/server/ProcessCaptureElicitation.js";
const request = {
  capability: "process_capture" as const,
  roots: [realpathSync("/tmp")],
  executables: [process.execPath],
  environment_names: ["PATH"],
  network: "external" as const,
  mount: false,
  operation_identity: "capture:test",
};
const now = Date.parse("2026-07-18T00:00:00.000Z");
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
describe("process-capture MCP elicitation grants", () => {
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
    const future = now + 600000;
    for (let index = 0; index < 4096; index += 1)
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
    expect(consumedNonces.size).toBe(4096);
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
        remediation: "elicit",
      });
      expect(retry.ok).toBe(false);
    },
  );
});
