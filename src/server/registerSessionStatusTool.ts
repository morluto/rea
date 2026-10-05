import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import { buildCapabilityInventory } from "../application/CapabilityInventory.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { ClientFeatureAvailability } from "../contracts/toolOutputSchemaPrimitives.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import { createServerIdentity } from "../serverIdentity.js";
import { mcpClientMetadata } from "./mcpClientMetadata.js";
import type { SessionAvailability } from "./sessionAvailabilityPolicy.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

type ToolAvailability = ReturnType<typeof buildCapabilityInventory>[number];

/** Inputs required to register the binary session status tool. */
export interface SessionStatusToolOptions {
  readonly server: McpServer;
  readonly session: BinarySessionPort;
  readonly contract: ReturnType<typeof toolContract<"binary_session">>;
  readonly startedAt: string;
  readonly availabilityPolicy: () => SessionAvailability;
}

/** Register the read-only provider and target status operation. */
export const registerSessionStatusTool = (
  options: SessionStatusToolOptions,
): void => {
  const { server, session, contract, startedAt, availabilityPolicy } = options;
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    (input, context) => {
      const { client, clientFeatures, protocolVersion } =
        mcpClientMetadata(context);
      const status = session.status();
      const statusObject = jsonObjectSchema.parse(status);
      const toolAvailability = buildCapabilityInventory(
        status,
        availabilityPolicy(),
        clientFeatures,
      );
      const serverIdentity = createServerIdentity({
        startedAt,
        expected: {
          ...(input.expected_package_version === undefined
            ? {}
            : { package_version: input.expected_package_version }),
          ...(input.expected_catalog_digest === undefined
            ? {}
            : { catalog_digest: input.expected_catalog_digest }),
          ...(input.expected_server_path === undefined
            ? {}
            : { server_path: input.expected_server_path }),
        },
        ...(client === undefined ? {} : { client }),
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
      });
      return toCallToolResult(
        {
          ok: true,
          value: projectSessionStatus({
            status: statusObject,
            toolAvailability,
            serverIdentity,
            clientFeatures,
          }),
        },
        contract,
      );
    },
  );
};

const projectSessionStatus = (options: {
  readonly status: Readonly<
    Record<string, import("../domain/jsonValue.js").JsonValue>
  >;
  readonly toolAvailability: readonly ToolAvailability[];
  readonly serverIdentity: ReturnType<typeof createServerIdentity>;
  readonly clientFeatures: ClientFeatureAvailability;
}) =>
  jsonObjectSchema.parse({
    ...options.status,
    tool_availability: options.toolAvailability,
    client_features: options.clientFeatures,
    server_identity: options.serverIdentity,
  });
