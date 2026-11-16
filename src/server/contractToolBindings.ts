import type { EvidenceRequestFrameInput } from "../domain/evidenceInputContract.js";
import type { Logger } from "pino";
import type { z } from "zod";

import type {
  AnalysisOperationPort,
  ExecutionOptions,
} from "../ports/AnalysisProvider.js";
import type { AnalysisViewRetention } from "../application/analysisView/AnalysisViewService.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import type {
  EvidenceUnknownWriter,
  EvidenceWriter,
} from "../application/investigation/InvestigationRecordPort.js";
import type { AnalysisViewRequest } from "../domain/analysisView/analysisViewRequest.js";
import { TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { invariantViolation } from "../domain/internalInvariant.js";
import { err, ok, type Result } from "../domain/result.js";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  optionalProviderUnavailable,
  type OptionalProviderLoadFailure,
} from "../ports/OptionalObservationProviders.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import type { InvestigationWorkflowExecution } from "../application/investigation/InvestigationWorkflows.js";
import type { ArtifactResourceScope } from "../resources/index.js";
import {
  type AnalysisWorkflow,
  type AnalysisWorkflowOutcome,
  type ApplicationWorkflowRequest,
  createAnalysisToolHandler,
  createApplicationToolHandler,
  createDerivedToolHandler,
  type DerivedAcquisition,
  type DerivedSources,
  createEvidenceToolHandler,
  createRetainedSummaryToolHandler,
  createValueToolHandler,
  type ContractToolService,
  type ValueOutcome,
  type ValueToolRequest,
} from "./contractToolHandler.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { ExternalMutationAdmission } from "./externalMutationAdmission.js";
import {
  createExternalMutationToolHandler,
  type ExternalMutation,
} from "./externalMutationToolHandler.js";
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

/**
 * Run the contract's workflow and deliver its Evidence. After SDK admission
 * the workflow receives the contract's request frame (the parsed input, with
 * declared Evidence inputs still unchecked); an application-admitted workflow
 * receives the raw request and validates it itself.
 */
type EvidenceBinding<Input = unknown> = (
  | {
      readonly admission: "sdk";
      readonly run: EvidenceOperation<Input>;
      readonly summary?: never;
      readonly value?: never;
      readonly derive?: never;
      readonly acquire?: never;
      readonly workflow?: never;
      readonly analyze?: never;
      readonly mutation?: never;
      readonly query?: never;
    }
  | {
      readonly admission: "application";
      readonly run: EvidenceOperation<unknown>;
      readonly summary?: never;
      readonly value?: never;
      readonly derive?: never;
      readonly acquire?: never;
      readonly workflow?: never;
      readonly analyze?: never;
      readonly mutation?: never;
      readonly query?: never;
    }
) & {
  /**
   * The source a view's response-overflow recovery may name again, read from
   * the raw request, when the operation projects a view of other Evidence.
   */
  readonly viewSource?: (input: unknown) => JsonValue | undefined;
  /**
   * Why the optional provider behind this operation failed to load. Every
   * call is then refused as unavailable before admission, naming the tool.
   */
  readonly unavailable?: OptionalProviderLoadFailure | undefined;
};

type ValueOperation<Input> = (
  input: Input,
  request: ValueToolRequest,
) => Promise<ValueOutcome>;

/**
 * Run a workflow that returns a plain JSON value rather than Evidence, and
 * deliver it against the contract's output schema. It records no Evidence.
 * It runs outside analysis admission, so provider-free guidance, discovery
 * and status reads answer without waiting on an analysis; one that declares
 * `admitted: true` runs under analysis admission like an Evidence workflow.
 */
type ValueBinding<Input = unknown> = {
  readonly admitted?: true;
} & (
  | {
      readonly admission: "sdk";
      readonly value: ValueOperation<Input>;
      readonly run?: never;
      readonly summary?: never;
      readonly derive?: never;
      readonly acquire?: never;
      readonly workflow?: never;
      readonly analyze?: never;
      readonly mutation?: never;
      readonly query?: never;
    }
  | {
      readonly admission: "application";
      readonly value: ValueOperation<unknown>;
      readonly run?: never;
      readonly summary?: never;
      readonly derive?: never;
      readonly acquire?: never;
      readonly workflow?: never;
      readonly analyze?: never;
      readonly mutation?: never;
      readonly query?: never;
    }
);

/** A read of the analysis admission grants for the call, returning a value. */
type AnalysisQuery<Input> = (
  input: Input,
  analysis: AnalysisOperationPort,
  request: ValueToolRequest,
) => Promise<ValueOutcome>;

/**
 * Read the analysis that admission grants for the call and deliver the plain
 * JSON value it returns, as a value binding does. A server that admits no
 * analysis refuses the binding at startup.
 */
interface QueryBinding<Input> {
  readonly admission: "sdk";
  readonly query: AnalysisQuery<Input>;
  readonly run?: never;
  readonly summary?: never;
  readonly value?: never;
  readonly derive?: never;
  readonly acquire?: never;
  readonly workflow?: never;
  readonly analyze?: never;
  readonly mutation?: never;
}

/**
 * Derive Evidence from Evidence the session holds (a comparison or an
 * investigation workflow). The session owner admits the call and resolves
 * each session-held input; the sources read are retained and the derived
 * Evidence is recorded with its unknowns, as for every session workflow.
 * The workflow validates its own request, so it receives the input as the
 * selected admission delivers it.
 *
 * A derivation that also reads caller-named files (artifact inventories,
 * Evidence bundles) declares the artifact resource scope it reads them
 * under and `acquire`s them before deriving: the readers open and release
 * every handle in that scope, which keeps any handle whose release failed
 * for a later cleanup retry. An acquisition failure is delivered as is,
 * before the derivation starts.
 */
type DerivedBinding = {
  readonly admission: ContractInputAdmission;
  readonly session: BinarySessionPort;
  readonly run?: never;
  readonly summary?: never;
  readonly value?: never;
  readonly workflow?: never;
  readonly view?: never;
  readonly analyze?: never;
  readonly mutation?: never;
  readonly query?: never;
} & (
  | {
      readonly derive: (
        input: unknown,
        evidenceForAnalysis: BinarySessionPort["evidenceForAnalysis"],
        signal: AbortSignal,
      ) => Result<InvestigationWorkflowExecution, AnalysisError>;
      readonly acquire?: never;
      readonly resources?: never;
    }
  | {
      readonly resources: ArtifactResourceScope;
      readonly acquire: (
        input: unknown,
        sources: DerivedSources & {
          readonly resources: ArtifactResourceScope;
        },
      ) => ReturnType<DerivedAcquisition>;
      readonly derive?: never;
    }
);

/**
 * Admit `detail`/`view` in the adapter, run the workflow on the remaining
 * input, and retain the complete Evidence behind a summary.
 */
interface RetainedSummaryBinding<Input> {
  readonly admission: ContractInputAdmission;
  readonly summary: EvidenceOperation<Omit<Input, "detail" | "view">>;
  readonly run?: never;
  readonly value?: never;
  readonly derive?: never;
  readonly acquire?: never;
  readonly workflow?: never;
  readonly view?: never;
  readonly analyze?: never;
  readonly mutation?: never;
  readonly query?: never;
}

/**
 * Run an application workflow that completes Evidence from session-held
 * Evidence or caller-named files, under analysis admission, and deliver it
 * with the sources it read and its residual unknown. When the request
 * selects a view (or a summary), the view is staged against the completed
 * Evidence before anything is recorded, and the call is refused before the
 * workflow runs if the complete Evidence cannot be retained.
 */
interface ApplicationWorkflowBinding<Input> {
  readonly workflow: (
    input: Input,
    request: ApplicationWorkflowRequest,
  ) => Promise<Result<InvestigationWorkflowExecution, AnalysisError>>;
  readonly view?: (input: Input) => AnalysisViewRequest | undefined;
  readonly run?: never;
  readonly summary?: never;
  readonly value?: never;
  readonly derive?: never;
  readonly acquire?: never;
  readonly analyze?: never;
  readonly mutation?: never;
  readonly query?: never;
}

/** An application-admitted workflow validates the raw request itself. */
type ApplicationBinding<Input = unknown> =
  | (ApplicationWorkflowBinding<Input> & { readonly admission: "sdk" })
  | (ApplicationWorkflowBinding<unknown> & {
      readonly admission: "application";
    });

/**
 * Run a provider-backed workflow on the analysis that admission grants for
 * the call. When `detail` selects delivery (`detail: "delivery"`), it never
 * reaches the workflow and a summary retains the complete Evidence.
 */
type AnalysisBinding<Input> = {
  readonly admission: "sdk";
  readonly run?: never;
  readonly summary?: never;
  readonly value?: never;
  readonly derive?: never;
  readonly acquire?: never;
  readonly workflow?: never;
  readonly view?: never;
  readonly mutation?: never;
  readonly query?: never;
} & (Input extends { readonly detail: "complete" | "summary" }
  ? {
      readonly detail: "delivery";
      readonly analyze: AnalysisOperation<Omit<Input, "detail">>;
    }
  : {
      readonly detail?: never;
      readonly analyze: AnalysisOperation<Input>;
    });

type AnalysisOperation<Input> = (
  input: Input,
  analysis: AnalysisOperationPort,
  request: ApplicationWorkflowRequest,
) => Promise<Result<AnalysisWorkflowOutcome, AnalysisError>>;

/**
 * Run a command that may change the bound artifact under the session's
 * external-mutation admission, with owned cleanup (see `ExternalMutation`).
 */
interface ExternalMutationBinding<Input> {
  readonly admission: "sdk";
  readonly session: ExternalMutationAdmission | undefined;
  readonly mutation: ExternalMutation<Input>;
  readonly run?: never;
  readonly summary?: never;
  readonly value?: never;
  readonly derive?: never;
  readonly acquire?: never;
  readonly workflow?: never;
  readonly analyze?: never;
  readonly query?: never;
}

/** How one named contract runs over MCP; only summary-capable contracts take `summary`. */
export type ContractToolBinding<Name extends CatalogToolName> =
  // The SDK admits the request frame: declared Evidence inputs stay
  // unchecked until the workflow resolves them.
  | EvidenceBinding<EvidenceRequestFrameInput<ContractInput<Name>>>
  | ValueBinding<EvidenceRequestFrameInput<ContractInput<Name>>>
  | ApplicationBinding<EvidenceRequestFrameInput<ContractInput<Name>>>
  | DerivedBinding
  | AnalysisBinding<ContractInput<Name>>
  | ExternalMutationBinding<EvidenceRequestFrameInput<ContractInput<Name>>>
  | QueryBinding<ContractInput<Name>>
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
  /** Records application Evidence together with its residual unknown. */
  readonly recordEvidenceWithUnknown?:
    | EvidenceUnknownWriter["recordEvidenceWithUnknown"]
    | undefined;
  readonly evidenceById?: EvidenceLookup | undefined;
  readonly withAdmittedAnalysis?: WithAdmittedAnalysis | undefined;
}

/** A session-only derivation acquires nothing; it derives from session-held Evidence. */
const derivedAcquisition = (binding: DerivedBinding): DerivedAcquisition => {
  if (binding.acquire !== undefined) {
    const { acquire, resources } = binding;
    return (input, sources) => acquire(input, { ...sources, resources });
  }
  const { derive } = binding;
  return async (input, { evidenceForAnalysis, signal }) =>
    ok(() => derive(input, evidenceForAnalysis, signal));
};

/** Refuse every call of an operation whose optional provider failed to load. */
const unavailableToolHandler =
  (
    server: EvidenceMcpServer,
    contract: ToolContract,
    failure: OptionalProviderLoadFailure,
  ) =>
  async (): Promise<CallToolResult> =>
    server.delivery.toCallToolResult(
      err(optionalProviderUnavailable(failure, contract.name)),
      contract,
    );

/** A provider-backed workflow runs only on the analysis admission grants. */
const requiredAdmission = (
  admission: WithAdmittedAnalysis | undefined,
  name: string,
): WithAdmittedAnalysis => {
  if (admission === undefined)
    throw invariantViolation(
      `MCP tool ${name} runs on admitted analysis, but the server admits none`,
    );
  return admission;
};

/** A query reads the analysis its required admission grants. */
const analysisQuery =
  (query: AnalysisQuery<unknown>, name: string) =>
  (
    input: unknown,
    request: ValueToolRequest & { readonly analysis?: AnalysisOperationPort },
  ): Promise<ValueOutcome> => {
    if (request.analysis === undefined)
      throw invariantViolation(
        `MCP tool ${name} reads admitted analysis, but admission granted none`,
      );
    return query(input, request.analysis, request);
  };

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
  const {
    logger,
    recordEvidence,
    recordEvidenceWithUnknown,
    evidenceById,
    withAdmittedAnalysis,
  } = dependencies;
  const retention: AnalysisViewRetention = { recordEvidence, evidenceById };
  const table: Readonly<
    Record<
      string,
      | EvidenceBinding
      | ValueBinding
      | ApplicationBinding
      | DerivedBinding
      | {
          readonly admission: "sdk";
          readonly analyze: AnalysisWorkflow;
          readonly detail?: "delivery";
          readonly value?: never;
          readonly workflow?: never;
          readonly derive?: never;
          readonly acquire?: never;
          readonly run?: never;
          readonly mutation?: never;
          readonly query?: never;
        }
      | ExternalMutationBinding<unknown>
      | QueryBinding<unknown>
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
      binding.run !== undefined && binding.unavailable !== undefined
        ? unavailableToolHandler(server, contract, binding.unavailable)
        : binding.mutation !== undefined
          ? createExternalMutationToolHandler(
              server,
              binding.session,
              binding.mutation,
              logger,
              retention,
            )(contract)
          : binding.analyze !== undefined
            ? createAnalysisToolHandler(
                server,
                binding.analyze,
                logger,
                retention,
                requiredAdmission(withAdmittedAnalysis, contract.name),
                binding.detail === "delivery",
              )(contract)
            : binding.query !== undefined
              ? createValueToolHandler(
                  server,
                  analysisQuery(binding.query, contract.name),
                  logger,
                  requiredAdmission(withAdmittedAnalysis, contract.name),
                  recordEvidence,
                )(contract)
              : binding.value !== undefined
                ? createValueToolHandler(
                    server,
                    binding.value,
                    logger,
                    binding.admitted === true
                      ? withAdmittedAnalysis
                      : undefined,
                    recordEvidence,
                  )(contract)
                : binding.workflow !== undefined
                  ? createApplicationToolHandler(
                      server,
                      binding,
                      logger,
                      {
                        recordEvidence,
                        recordEvidenceWithUnknown,
                        evidenceById,
                      },
                      withAdmittedAnalysis,
                    )(contract)
                  : binding.derive !== undefined ||
                      binding.acquire !== undefined
                    ? createDerivedToolHandler(
                        server,
                        binding.session,
                        derivedAcquisition(binding),
                        logger,
                      )(contract)
                    : binding.run !== undefined
                      ? createEvidenceToolHandler(
                          server,
                          binding.run,
                          logger,
                          recordEvidence,
                          withAdmittedAnalysis,
                          binding.viewSource,
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
