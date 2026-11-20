import type { OwnedMcpStdioTransport } from "../../src/process/OwnedMcpStdioTransport.js";
import type { OwnedProviderProcessSpawnOptions } from "../../src/process/ProviderProcess.js";

export function createOwnedMcpStdioTransport(
  options: Omit<OwnedProviderProcessSpawnOptions, "runId" | "stdin">,
): Promise<OwnedMcpStdioTransport>;
