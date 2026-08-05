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
});
