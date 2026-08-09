import type { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";

import type { BinarySessionPort } from "../application/BinarySession.js";
import { buildCapabilityInventory } from "../application/CapabilityInventory.js";
import {
  binarySessionInputSchema,
  SESSION_TOOL_CONTRACTS,
} from "../contracts/toolContracts.js";
import type { ClientFeatureAvailability } from "../contracts/toolOutputSchemaPrimitives.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import { createServerIdentity } from "../serverIdentity.js";
import { mcpClientMetadata } from "./mcpClientMetadata.js";
import type { SessionAvailability } from "./sessionAvailabilityPolicy.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

type BinarySessionInput = z.output<typeof binarySessionInputSchema>;
type ToolAvailability = ReturnType<typeof buildCapabilityInventory>[number];

/** Inputs required to register the binary session status tool. */
export interface SessionStatusToolOptions {
  readonly server: McpServer;
  readonly session: BinarySessionPort;
  readonly contract: (typeof SESSION_TOOL_CONTRACTS)[2];
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
            input: input,
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
  readonly input: BinarySessionInput;
  readonly status: Readonly<
    Record<string, import("../domain/jsonValue.js").JsonValue>
  >;
  readonly toolAvailability: readonly ToolAvailability[];
  readonly serverIdentity: ReturnType<typeof createServerIdentity>;
  readonly clientFeatures: ClientFeatureAvailability;
}) => {
  if (options.input.detail === "full")
    return jsonObjectSchema.parse({
      view: "full",
      ...options.status,
      tool_availability: options.toolAvailability,
      client_features: options.clientFeatures,
      server_identity: options.serverIdentity,
    });
  const open = options.status.open === true;
  const activeProvider = activeProviderFrom(options.status);
  if (options.input.detail === "capabilities") {
    const filtered =
      options.input.capability_family === undefined
        ? options.toolAvailability
        : options.toolAvailability.filter(
            ({ surface }) => surface === options.input.capability_family,
          );
    const items = filtered.slice(
      options.input.cursor,
      options.input.cursor + options.input.limit,
    );
    const nextCursor = options.input.cursor + items.length;
    return jsonObjectSchema.parse({
      view: "capabilities",
      open,
      provider: options.status.provider,
      active_provider: activeProvider,
      capability_family: options.input.capability_family ?? null,
      capabilities: {
        items,
        cursor: options.input.cursor,
        limit: options.input.limit,
        total: filtered.length,
        next_cursor: nextCursor < filtered.length ? nextCursor : null,
        has_more: nextCursor < filtered.length,
      },
      client_features: options.clientFeatures,
    });
  }
  return jsonObjectSchema.parse({
    view: "summary",
    open,
    provider: options.status.provider,
    active_provider: activeProvider,
    target: open ? targetFrom(options.status) : null,
    alignment: options.serverIdentity.alignment,
    analysis_activity: options.status.analysis_activity,
    recommended_actions: recommendedActions(
      open,
      options.serverIdentity.alignment.state,
    ),
  });
};

const activeProviderFrom = (
  status: Readonly<Record<string, import("../domain/jsonValue.js").JsonValue>>,
) => {
  const binding = jsonObjectSchema.safeParse(status.analysis_provider_binding);
  return binding.success ? (binding.data.provider ?? null) : null;
};

const targetFrom = (
  status: Readonly<Record<string, import("../domain/jsonValue.js").JsonValue>>,
) => ({
  path: status.path,
  format: status.format,
  kind: status.kind,
  sha256: status.sha256,
  architecture: status.architecture ?? null,
});

const recommendedActions = (
  open: boolean,
  alignment: string,
): readonly string[] => [
  ...(alignment === "mcp_server_restart_required"
    ? ["Restart the registered MCP server or client before continuing."]
    : []),
  ...(!open
    ? [
        "For a supplied target, route by format: ASAR/JavaScript to analyze_javascript_application; archive/package to open_binary(path), then inspect_artifact or inventory_artifact on the active target; managed PE/CLI to inspect_managed_artifact; browser/Electron runtimes to their list-target tools; native binaries to open_binary.",
      ]
    : [
        "Continue from the active target with binary_overview or a bounded target-specific query.",
      ]),
];
