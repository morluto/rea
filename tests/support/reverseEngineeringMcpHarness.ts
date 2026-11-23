import pino from "pino";

import type { EvidenceLookup } from "../../src/application/EvidenceInputResolver.js";
import type { EvidenceWriter } from "../../src/application/investigation/InvestigationRecordPort.js";
import type { WithAdmittedAnalysis } from "../../src/server/analysisAdmission.js";
import type { EvidenceMcpServer } from "../../src/server/EvidenceMcpServer.js";
import type { ExternalMutationAdmission } from "../../src/server/externalMutationAdmission.js";
import {
  registerServiceTools,
  type ReverseEngineeringToolOptions,
} from "../../src/server/serviceToolBindings.js";
import { createToolResultDelivery } from "../../src/server/toolResult.js";

type RegisteredHandler = (input: unknown, context: unknown) => Promise<unknown>;

export const invokeWithLiveSignal = (
  handler: RegisteredHandler,
  input: unknown,
): Promise<unknown> =>
  handler(input, { mcpReq: { signal: new AbortController().signal } });

/**
 * A server that keeps each registered handler for direct invocation, with
 * the delivery the shared binding loop reads.
 */
export const createReverseEngineeringMcpHarness = (): {
  server: EvidenceMcpServer;
  handler: (name: string) => RegisteredHandler;
} => {
  const registrations = new Map<string, RegisteredHandler>();
  const server = {
    delivery: createToolResultDelivery(2 * 1024 * 1024),
    registerTool: (
      name: string,
      _options: unknown,
      handler: RegisteredHandler,
    ) => registrations.set(name, handler),
  } as unknown as EvidenceMcpServer;

  return {
    server,
    handler: (name) => {
      const registered = registrations.get(name);
      if (registered === undefined)
        throw new Error(`${name} MCP handler was not registered`);
      return registered;
    },
  };
};

/** Bind objdump and Rizin through the shared table, as composition does. */
export const registerReverseEngineeringTools = (
  server: EvidenceMcpServer,
  service: ReverseEngineeringToolOptions["service"],
  options: {
    readonly recordEvidence?: EvidenceWriter["recordEvidence"];
    readonly evidenceById?: EvidenceLookup;
    readonly withAdmittedAnalysis?: WithAdmittedAnalysis;
    readonly session?: ExternalMutationAdmission;
  } = {},
): void =>
  registerServiceTools(
    server,
    { reverseEngineering: { service, session: options.session } },
    {
      logger: pino({ enabled: false }),
      recordEvidence: options.recordEvidence,
      evidenceById: options.evidenceById,
      withAdmittedAnalysis: options.withAdmittedAnalysis,
    },
  );
