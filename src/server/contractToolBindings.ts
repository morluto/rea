import type { Logger } from "pino";
import type { z } from "zod";

import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import type { AnalysisViewRetention } from "../application/analysisView/AnalysisViewService.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import { invariantViolation } from "../domain/internalInvariant.js";
import type { Result } from "../domain/result.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import {
  createEvidenceToolHandler,
  createRetainedSummaryToolHandler,
  type ContractToolService,
} from "./contractToolHandler.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import {
  applicationToolRegistrationOptions,
  toolRegistrationOptions,
} from "./toolRegistrationOptions.js";

type CatalogContract = (typeof TOOL_CONTRACTS)[number];

/** A public tool name in the contract registry. */
export type CatalogToolName = CatalogContract["name"];

type ContractNamed<Name extends CatalogToolName> = Extract<
  CatalogContract,
  { readonly name: Name }
>;

type ContractInput<Name extends CatalogToolName> = z.output<
  ContractNamed<Name>["inputSchema"]
>;

/**
 * Who admits a raw MCP request: the SDK through the contract's request frame,
 * or the application workflow, which validates it and projects its own input
 * errors.
 */
export type ContractInputAdmission = "sdk" | "application";

type EvidenceOperation<Input> = (
  input: Input,
  options: ExecutionOptions,
) => Promise<Result<Evidence, AnalysisError>>;

/** Run the contract's workflow on the raw request and deliver its Evidence. */
interface EvidenceBinding {
  readonly admission: ContractInputAdmission;
  readonly run: EvidenceOperation<unknown>;
  readonly summary?: never;
}

/**
 * Admit `detail`/`view` in the adapter, run the workflow on the remaining
 * input, and retain the complete Evidence behind a summary.
 */
interface RetainedSummaryBinding<Input> {
  readonly admission: ContractInputAdmission;
  readonly summary: EvidenceOperation<Omit<Input, "detail" | "view">>;
  readonly run?: never;
}

/** How one named contract runs over MCP; only summary-capable contracts take `summary`. */
export type ContractToolBinding<Name extends CatalogToolName> =
  | EvidenceBinding
  | (ContractInput<Name> extends { readonly detail: "complete" | "summary" }
      ? RetainedSummaryBinding<ContractInput<Name>>
      : never);

/** MCP bindings keyed by their exact contract name. */
export type ContractToolBindings = {
  readonly [Name in CatalogToolName]?: ContractToolBinding<Name>;
};

/** Shared logging, recording, retention and admission for bound contracts. */
export interface ContractToolDependencies {
  readonly logger: Logger;
  readonly recordEvidence?: EvidenceWriter["recordEvidence"] | undefined;
  readonly evidenceById?: EvidenceLookup | undefined;
  readonly withAdmittedAnalysis?: WithAdmittedAnalysis | undefined;
}

/** Bind every named operation of one contract service with one admission. */
export const contractServiceBindings = <Name extends CatalogToolName>(
  service: ContractToolService<Name>,
  names: readonly Name[],
  admission: ContractInputAdmission = "sdk",
): ContractToolBindings =>
  Object.fromEntries(
    names.map((name) => [
      name,
      {
        admission,
        run: (input: unknown, options: ExecutionOptions) =>
          service.execute(name, input, options),
      },
    ]),
  );

type SummaryContract = ToolContract<
  string,
  z.ZodType<
    Readonly<Record<string, unknown>> & {
      readonly detail: "complete" | "summary";
    }
  >
>;

/**
 * Register each bound contract from the registry through the shared handler
 * its binding selects. A binding that names no registered contract is refused
 * at startup, so a renamed or removed contract cannot leave a dead handler.
 */
export const registerContractTools = (
  server: EvidenceMcpServer,
  bindings: ContractToolBindings,
  dependencies: ContractToolDependencies,
  contracts: readonly ToolContract[] = TOOL_CONTRACTS,
): void => {
  const { logger, recordEvidence, evidenceById, withAdmittedAnalysis } =
    dependencies;
  const retention: AnalysisViewRetention = { recordEvidence, evidenceById };
  const table: Readonly<
    Record<
      string,
      | EvidenceBinding
      | RetainedSummaryBinding<Readonly<Record<string, unknown>>>
      | undefined
    >
    // The table's exact per-name types are checked where it is written.
  > = bindings as never;
  const unbound = new Set(Object.keys(table));
  for (const contract of contracts) {
    const binding = table[contract.name];
    if (binding === undefined) continue;
    unbound.delete(contract.name);
    const registration =
      binding.admission === "sdk"
        ? toolRegistrationOptions(contract)
        : applicationToolRegistrationOptions(contract);
    const handler =
      binding.run !== undefined
        ? createEvidenceToolHandler(
            server,
            binding.run,
            logger,
            recordEvidence,
            withAdmittedAnalysis,
          )(contract)
        : createRetainedSummaryToolHandler(
            server,
            contract as SummaryContract,
            binding.summary,
            logger,
            retention,
            withAdmittedAnalysis,
          );
    server.registerTool(contract.name, registration, handler);
  }
  if (unbound.size > 0)
    throw invariantViolation(
      `MCP tool bindings name no registered contract: ${[...unbound].join(", ")}`,
    );
};
