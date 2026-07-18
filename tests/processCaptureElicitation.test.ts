import { isInputRequiredResult } from "@modelcontextprotocol/server";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PermissionAuthority } from "../src/application/PermissionAuthority.js";
import { createPermissionPolicy } from "../src/domain/permissionPolicy.js";
import {
  authorizeProcessCaptureWithElicitation,
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

describe("process-capture MCP elicitation", () => {
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
      modern: () => true,
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
      supported: () => true,
      modern: () => false,
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

    const modern = { ...elicitation, modern: () => true };
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
      modern: () => true,
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
      modern: () => true,
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
      modern: () => true,
      consumedNonces,
    };
    await authorizeProcessCaptureWithElicitation(
      authority,
      request,
      requestContext(),
      elicitation,
    );
    const future = Date.now() + 600_000;
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

    consumedNonces.set("occupied-0", Date.now() - 1);
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
      const root = await mkdtemp(join(tmpdir(), "rea-elicit-rollback-"));
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
        modern: () => true,
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
