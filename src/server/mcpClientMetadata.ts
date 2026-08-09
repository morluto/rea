import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type ServerContext,
} from "@modelcontextprotocol/server";

import type { ClientFeatureAvailability } from "../contracts/toolOutputSchemaPrimitives.js";
import type { ConnectedClientIdentity } from "../serverIdentity.js";

/** Client metadata bound to the current SDK request rather than server-global state. */
export const mcpClientMetadata = (context: {
  readonly mcpReq: Pick<ServerContext["mcpReq"], "envelope">;
}) => {
  const envelope = context.mcpReq.envelope;
  const client = implementation(
    mcpEnvelopeValue(envelope, CLIENT_INFO_META_KEY),
  );
  const protocolVersion = mcpEnvelopeValue(envelope, PROTOCOL_VERSION_META_KEY);
  return {
    ...(client === undefined ? {} : { client }),
    clientFeatures: capabilityFeatures(
      mcpEnvelopeValue(envelope, CLIENT_CAPABILITIES_META_KEY),
    ),
    ...(typeof protocolVersion === "string" ? { protocolVersion } : {}),
  };
};

/** Read an SDK-defined metadata key from the SDK's currently opaque envelope type. */
export const mcpEnvelopeValue = (
  envelope: ServerContext["mcpReq"]["envelope"],
  key: string,
): unknown => (envelope === undefined ? undefined : Reflect.get(envelope, key));

const implementation = (value: unknown): ConnectedClientIdentity | undefined =>
  isRecord(value) &&
  typeof value.name === "string" &&
  typeof value.version === "string"
    ? { name: value.name, version: value.version }
    : undefined;

const capabilityFeatures = (value: unknown): ClientFeatureAvailability => {
  const capabilities = isRecord(value) ? value : {};
  const elicitation = isRecord(capabilities.elicitation)
    ? capabilities.elicitation
    : {};
  return {
    elicitation_form: elicitation.form !== undefined,
    elicitation_url: elicitation.url !== undefined,
    roots: capabilities.roots !== undefined,
    sampling: capabilities.sampling !== undefined,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
