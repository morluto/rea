import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import {
  binarySessionInputSchema,
  SESSION_TOOL_CONTRACTS,
} from "../contracts/toolContracts.js";
import { toCallToolResult } from "./toolResult.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import { createServerIdentity } from "../serverIdentity.js";
import { buildCapabilityInventory } from "../application/CapabilityInventory.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { safeParseToolInput } from "./toolInputValidation.js";

/** Register the read-only provider and target status operation. */
export const registerSessionStatusTool = (
  server: McpServer,
  session: BinarySessionPort,
  contract: (typeof SESSION_TOOL_CONTRACTS)[2],
  startedAt: string,
  availabilityPolicy: () => {
    readonly processCaptureEnabled: boolean;
    readonly evidenceFileRoots: number;
    readonly browserObservationEnabled?: boolean;
    readonly electronObservationEnabled?: boolean;
    readonly javascriptReplayEnabled?: boolean;
    readonly managedRuntimeEnabled?: boolean;
  },
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    (input) => {
      const parsedInput = safeParseToolInput(
        binarySessionInputSchema,
        input,
        contract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, contract);
      const parsed = parsedInput.value;
      const client = server.server.getClientVersion();
      const clientCapabilities = server.server.getClientCapabilities();
      const status = session.status();
      return toCallToolResult(
        {
          ok: true,
          value: {
            ...jsonObjectSchema.parse(status),
            tool_availability: buildCapabilityInventory(
              status,
              availabilityPolicy(),
            ),
            client_features: {
              elicitation_form:
                clientCapabilities?.elicitation?.form !== undefined,
              elicitation_url:
                clientCapabilities?.elicitation?.url !== undefined,
              roots: clientCapabilities?.roots !== undefined,
              sampling: clientCapabilities?.sampling !== undefined,
            },
            server_identity: createServerIdentity({
              startedAt,
              expected: {
                ...(parsed.expected_package_version === undefined
                  ? {}
                  : { package_version: parsed.expected_package_version }),
                ...(parsed.expected_catalog_digest === undefined
                  ? {}
                  : { catalog_digest: parsed.expected_catalog_digest }),
                ...(parsed.expected_server_path === undefined
                  ? {}
                  : { server_path: parsed.expected_server_path }),
              },
              ...(client === undefined ? {} : { client }),
              ...(server.server.getNegotiatedProtocolVersion() === undefined
                ? {}
                : {
                    protocolVersion:
                      server.server.getNegotiatedProtocolVersion(),
                  }),
            }),
          },
        },
        contract,
      );
    },
  );
};
