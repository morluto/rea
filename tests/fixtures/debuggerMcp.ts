import type { EvidenceLookup } from "../../src/application/EvidenceInputResolver.js";
import { silentLogger } from "../../src/logger.js";
import { EvidenceMcpServer } from "../../src/server/EvidenceMcpServer.js";
import type { ExternalMutationAdmission } from "../../src/server/externalMutationAdmission.js";
import type {
  CutterToolOptions,
  GdbToolOptions,
  RizinDebugToolOptions,
} from "../../src/server/debuggerToolBindings.js";
import {
  registerServiceTools,
  type ToolServices,
} from "../../src/server/serviceToolBindings.js";
import { createToolResultDelivery } from "../../src/server/toolResult.js";

type RecordEvidence = ConstructorParameters<typeof EvidenceMcpServer>[2];

/** Session-ledger dependencies a debugger server records into and reads. */
export interface DebuggerMcpLedger {
  readonly recordEvidence?: RecordEvidence;
  readonly evidenceById?: EvidenceLookup;
  /** Response budget; the delivery default when omitted. */
  readonly maxResponseBytes?: number;
}

/** An MCP server binding only the given debugger services from the shared table. */
const debuggerMcpServer = (
  name: string,
  services: Partial<ToolServices>,
  { recordEvidence, evidenceById, maxResponseBytes }: DebuggerMcpLedger,
): EvidenceMcpServer => {
  const server = new EvidenceMcpServer(
    { name, version: "1" },
    {},
    recordEvidence,
    createToolResultDelivery(maxResponseBytes),
  );
  registerServiceTools(server, services, {
    logger: silentLogger,
    recordEvidence,
    evidenceById,
  });
  return server;
};

/** An MCP server binding only the Rizin debugger tools over `manager`. */
export const rizinDebugMcpServer = (
  name: string,
  manager: RizinDebugToolOptions["manager"],
  session?: ExternalMutationAdmission,
  recordEvidence?: RecordEvidence,
): EvidenceMcpServer =>
  debuggerMcpServer(
    name,
    { rizinDebug: { manager, session } },
    { recordEvidence },
  );

/** An MCP server binding only the GDB session tools over `manager`. */
export const gdbMcpServer = (
  name: string,
  manager: GdbToolOptions["manager"],
  session?: ExternalMutationAdmission,
  ledger: DebuggerMcpLedger = {},
): EvidenceMcpServer =>
  debuggerMcpServer(name, { gdb: { manager, session } }, ledger);

/** An MCP server binding only the Cutter tools over `service`. */
export const cutterMcpServer = (
  name: string,
  service: CutterToolOptions["service"],
  session?: ExternalMutationAdmission,
  recordEvidence?: RecordEvidence,
): EvidenceMcpServer =>
  debuggerMcpServer(name, { cutter: { service, session } }, { recordEvidence });
