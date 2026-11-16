import { silentLogger } from "../../src/logger.js";
import { EvidenceMcpServer } from "../../src/server/EvidenceMcpServer.js";
import type { ExternalMutationAdmission } from "../../src/server/externalMutationAdmission.js";
import {
  registerServiceTools,
  type RizinDebugToolOptions,
} from "../../src/server/serviceToolBindings.js";
import { createToolResultDelivery } from "../../src/server/toolResult.js";

/** An MCP server binding only the Rizin debugger tools over `manager`. */
export const rizinDebugMcpServer = (
  name: string,
  manager: RizinDebugToolOptions["manager"],
  session?: ExternalMutationAdmission,
  recordEvidence?: ConstructorParameters<typeof EvidenceMcpServer>[2],
): EvidenceMcpServer => {
  const server = new EvidenceMcpServer(
    { name, version: "1" },
    {},
    recordEvidence,
    createToolResultDelivery(undefined),
  );
  registerServiceTools(
    server,
    { rizinDebug: { manager, session } },
    { logger: silentLogger, recordEvidence },
  );
  return server;
};
