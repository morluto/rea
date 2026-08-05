import { isInputRequiredResult } from "@modelcontextprotocol/server";
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
});
