import { randomUUID } from "node:crypto";

import {
  acceptedContent,
  inputRequired,
  inputResponse,
  type InputRequiredResult,
  type RequestStateCodec,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import { PermissionRequiredError } from "../domain/errors.js";
import {
  isPermissionRequestWithinCeiling,
  type PermissionGrant,
  type PermissionRequest,
} from "../domain/permissionPolicy.js";

const RESPONSE_KEY = "process_capture_grant";
const STATE_VERSION = 1;
const STATE_TTL_MS = 600_000;
const MAX_CONSUMED_NONCES = 4_096;

const grantResponseSchema = z.object({
  lifetime: z.enum(["once", "session"]).default("session"),
});

const grantResponseJsonSchema = {
  type: "object" as const,
  properties: {
    lifetime: {
      type: "string" as const,
      enum: ["once", "session"],
      default: "session",
    },
  },
  required: ["lifetime"],
};

const stateSchema = z.object({
  version: z.literal(STATE_VERSION),
  nonce: z.string().uuid(),
  request: z.object({
    capability: z.literal("process_capture"),
    roots: z.array(z.string()),
    executables: z.array(z.string()),
    environment_names: z.array(z.string()),
    origins: z.array(z.string()).optional(),
    network: z.enum(["none", "loopback", "external"]),
    mount: z.boolean(),
    operation_identity: z.string(),
  }),
});

export type ProcessCaptureElicitationState = z.infer<typeof stateSchema>;

/** Connection-owned SDK state used for process-capture grant elicitation. */
export interface ProcessCaptureElicitation {
  readonly stateCodec: RequestStateCodec<ProcessCaptureElicitationState>;
  readonly supported: () => boolean;
  readonly modern: () => boolean;
  readonly consumedNonces: Map<string, number>;
}

interface ProcessCaptureElicitationContext {
  readonly mcpReq: {
    readonly inputResponses?: Record<string, unknown>;
    readonly requestState: () => unknown;
  };
}

type PermissionResult = Awaited<ReturnType<PermissionAuthority["authorize"]>>;

/** Authorize capture or return a signed MCP input-required continuation. */
export const authorizeProcessCaptureWithElicitation = async (
  authority: PermissionAuthority,
  request: PermissionRequest,
  context: ProcessCaptureElicitationContext,
  elicitation: ProcessCaptureElicitation,
): Promise<PermissionResult | InputRequiredResult> => {
  const supported = elicitation.supported() && elicitation.modern();
  const initial = await authority.authorize(request, "read", {
    elicitationSupported: supported,
  });
  if (initial.ok || !(initial.error instanceof PermissionRequiredError))
    return initial;
  const denied = initial.error;
  if (
    !supported ||
    denied.requested.capability !== "process_capture" ||
    denied.ceiling === null ||
    !isPermissionRequestWithinCeiling(denied.requested, denied.ceiling)
  )
    return initial;

  const encodedState = context.mcpReq.requestState();
  if (encodedState !== undefined) {
    const state = stateSchema.safeParse(encodedState);
    if (!state.success || !sameRequest(state.data.request, denied.requested))
      return initial;
    const response = inputResponse(context.mcpReq.inputResponses, RESPONSE_KEY);
    if (response.kind === "elicit") {
      if (!consumeNonce(elicitation.consumedNonces, state.data.nonce))
        return initial;
    }
    if (response.kind === "elicit" && response.action === "accept") {
      const content = acceptedContent(
        context.mcpReq.inputResponses,
        RESPONSE_KEY,
        grantResponseSchema,
      );
      if (content === undefined) return initial;
      return grantAndAuthorize(authority, state.data.request, content.lifetime);
    }
    if (
      response.kind === "elicit" &&
      (response.action === "decline" || response.action === "cancel")
    )
      return initial;
  }

  const state = await elicitation.stateCodec.mint({
    version: STATE_VERSION,
    nonce: randomUUID(),
    request: {
      capability: "process_capture",
      roots: [...denied.requested.roots],
      executables: [...denied.requested.executables],
      environment_names: [...denied.requested.environment_names],
      network: denied.requested.network,
      mount: denied.requested.mount,
      operation_identity: denied.requested.operation_identity,
      ...(denied.requested.origins === undefined
        ? {}
        : { origins: [...denied.requested.origins] }),
    },
  });
  return inputRequired({
    inputRequests: {
      [RESPONSE_KEY]: inputRequired.elicit({
        message: permissionMessage(denied.requested),
        requestedSchema: grantResponseJsonSchema,
      }),
    },
    requestState: state,
  });
};

const grantAndAuthorize = async (
  authority: PermissionAuthority,
  request: PermissionRequest,
  lifetime: "once" | "session",
): Promise<PermissionResult> => {
  const grant: PermissionGrant = {
    ...request,
    grant_id: `elicited:${randomUUID()}`,
    lifetime,
    operation_identity: lifetime === "once" ? request.operation_identity : null,
    expires_at: null,
  };
  const granted = authority.grant(grant);
  if (!granted.ok)
    return authority.authorize(request, "read", {
      elicitationSupported: true,
    });
  let authorized: PermissionResult;
  try {
    authorized = await authority.authorize(request, "read", {
      elicitationSupported: true,
    });
  } catch (cause: unknown) {
    authority.revoke(grant.grant_id);
    throw cause;
  }
  if (!authorized.ok) authority.revoke(grant.grant_id);
  return authorized;
};

const sameRequest = (
  left: PermissionRequest,
  right: PermissionRequest,
): boolean =>
  left.capability === right.capability &&
  left.network === right.network &&
  left.mount === right.mount &&
  left.operation_identity === right.operation_identity &&
  sameOptionalStrings(left.origins, right.origins) &&
  sameStrings(left.roots, right.roots) &&
  sameStrings(left.executables, right.executables) &&
  sameStrings(left.environment_names, right.environment_names);

const sameStrings = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const sameOptionalStrings = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean =>
  left === undefined
    ? right === undefined
    : right !== undefined && sameStrings(left, right);

const consumeNonce = (
  consumed: Map<string, number>,
  nonce: string,
): boolean => {
  const now = Date.now();
  for (const [candidate, expiresAt] of consumed)
    if (expiresAt <= now) consumed.delete(candidate);
  if (consumed.has(nonce) || consumed.size >= MAX_CONSUMED_NONCES) return false;
  consumed.set(nonce, now + STATE_TTL_MS);
  return true;
};

const permissionMessage = (request: PermissionRequest): string =>
  [
    "Allow REA to run this exact process-capture scope?",
    `Executable: ${request.executables.join(", ") || "none"}`,
    `Filesystem roots: ${request.roots.join(", ") || "none"}`,
    `Environment names: ${request.environment_names.join(", ") || "none"}`,
    `Origins: ${request.origins?.join(", ") || "none"}`,
    `Network: ${request.network}`,
    `Mount access: ${request.mount ? "yes" : "no"}`,
    "Choose whether the grant applies once or for this MCP session.",
  ].join("\n");
