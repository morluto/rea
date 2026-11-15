import type { ArtifactResourceScope } from "../../src/resources/ArtifactResourceScope.js";
import type { ClientRegistrationCommand } from "../../src/domain/clientRegistrationCommand.js";
import {
  registerMcpClient,
  registerMcpClients,
} from "../../src/application/McpClientRegistration.js";
import type { McpRegistrationClient } from "../../src/application/McpRegistrationCatalog.js";
import { HOST_PLATFORM } from "../../src/platform/HostPlatform.js";

/**
 * `rea mcp add` for clients resolved for the running host, as the CLI runs it.
 * Tests that resolve clients for another platform call the owner directly.
 */
export const registerMcpClientOnHost = (
  client: McpRegistrationClient,
  launcher: ClientRegistrationCommand,
  signal: AbortSignal | undefined,
  resources: ArtifactResourceScope,
) =>
  registerMcpClient(
    client,
    launcher,
    signal,
    resources,
    HOST_PLATFORM.platform,
  );

/** Register each host-resolved client in order, as `rea mcp add` does. */
export const registerMcpClientsOnHost = (
  clients: readonly McpRegistrationClient[],
  launcher: ClientRegistrationCommand,
  signal: AbortSignal | undefined,
  resources: ArtifactResourceScope,
) =>
  registerMcpClients(
    clients,
    launcher,
    signal,
    resources,
    HOST_PLATFORM.platform,
  );
