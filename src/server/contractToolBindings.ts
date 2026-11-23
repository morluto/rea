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
import {
  toolContractEntry,
  type TOOL_CONTRACTS,
} from "../contracts/toolContracts.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { invariantViolation } from "../domain/internalInvariant.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  CallToolResult,
  ServerContext,
} from "@modelcontextprotocol/server";
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
  type AnalysisWorkflowOptions,
  type ApplicationWorkflowRequest,
  createAnalysisToolHandler,
  createApplicationToolHandler,
  createDerivedToolHandler,
  type DerivedAcquisition,
  type DerivedSources,
  createEvidenceToolHandler,
  createRetainedSummaryToolHandler,
  type RetainedSummaryOperation,
  createValueToolHandler,
  type ContractToolService,
  type ValueOutcome,
  type ValueToolRequest,
} from "./contractToolHandler.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { ExternalMutationAdmission } from "./externalMutationAdmission.js";
import {
  createProviderOperationToolHandler,
  type ProviderOperation,
  type ProviderOperationOptions,
} from "./providerOperationToolHandler.js";
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

type BindingModeKey =
  | "run"
  | "summary"
  | "value"
  | "derive"
  | "acquire"
  | "workflow"
  | "view"
  | "analyze"
  | "mutation"
  | "query"
  | "provider";

type ExclusiveBinding<Allowed extends BindingModeKey> = {
  readonly [Key in Exclude<BindingModeKey, Allowed>]?: never;
};

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
    }
  | {
      readonly admission: "application";
      readonly run: EvidenceOperation<unknown>;
    }
) &
  ExclusiveBinding<"run"> & {
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
  /**
   * Rewrite every response this tool delivers, its refusals included, such
   * as replacing secrets the caller typed with their handles.
   */
  readonly presentResult?: (result: CallToolResult) => CallToolResult;
} & ExclusiveBinding<"value"> &
  (
    | {
        readonly admission: "sdk";
        readonly value: ValueOperation<Input>;
      }
    | {
        readonly admission: "application";
        readonly value: ValueOperation<unknown>;
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
type QueryBinding<Input> = {
  readonly admission: "sdk";
  readonly query: AnalysisQuery<Input>;
} & ExclusiveBinding<"query">;

/**
 * Run the named provider operation on the analysis admission grants and
 * deliver its observation as atomic Evidence (see
 * `createProviderOperationToolHandler`). A server that admits no analysis
 * refuses the binding at startup.
 */
type ProviderBinding<Operation extends ProviderOperation> = {
  readonly admission: "sdk";
  readonly provider: ProviderOperationOptions & {
    /** The contract's own name: a binding runs only its named operation. */
    readonly operation: Operation;
  };
} & ExclusiveBinding<"provider">;

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
} & ExclusiveBinding<"derive" | "acquire"> &
  (
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
type RetainedSummaryBinding<Input> = RetainedSummaryOperation<Input> &
  ExclusiveBinding<"summary">;

/**
 * Run an application workflow that completes Evidence from session-held
 * Evidence or caller-named files, under analysis admission, and deliver it
 * with the sources it read and its residual unknown. When the request
 * selects a view (or a summary), the view is staged against the completed
 * Evidence before anything is recorded, and the call is refused before the
 * workflow runs if the complete Evidence cannot be retained.
 */
type ApplicationWorkflowBinding<Input> = {
  readonly workflow: (
    input: Input,
    request: ApplicationWorkflowRequest,
  ) => Promise<Result<InvestigationWorkflowExecution, AnalysisError>>;
  readonly view?: (input: Input) => AnalysisViewRequest | undefined;
} & ExclusiveBinding<"workflow" | "view">;

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
  readonly completionProgress?: AnalysisWorkflowOptions["completionProgress"];
} & ExclusiveBinding<"analyze"> &
  (Input extends { readonly detail: "complete" | "summary" }
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
type ExternalMutationBinding<Input> = {
  readonly admission: "sdk";
  readonly session: ExternalMutationAdmission | undefined;
  readonly mutation: ExternalMutation<Input>;
} & ExclusiveBinding<"mutation">;

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
  // Only a provider operation binds a provider, and only to its own name.
  | (Name extends ProviderOperation ? ProviderBinding<Name> : never)
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

type ErasedContractBinding =
  | EvidenceBinding
  | ValueBinding
  | ApplicationBinding
  | DerivedBinding
  | ({
      readonly admission: "sdk";
      readonly analyze: AnalysisWorkflow;
    } & ExclusiveBinding<"analyze"> &
      AnalysisWorkflowOptions)
  | ExternalMutationBinding<unknown>
  | QueryBinding<unknown>
  | ProviderBinding<ProviderOperation>
  | RetainedSummaryBinding<Readonly<Record<string, unknown>>>;

const createContractBindingHandler = (
  server: EvidenceMcpServer,
  contract: CatalogContract,
  binding: ErasedContractBinding,
  dependencies: ContractToolDependencies,
  retention: AnalysisViewRetention,
): ((input: unknown, context: ServerContext) => Promise<CallToolResult>) => {
  const {
    logger,
    recordEvidence,
    recordEvidenceWithUnknown,
    evidenceById,
    withAdmittedAnalysis,
  } = dependencies;
  if (binding.run !== undefined && binding.unavailable !== undefined)
    return unavailableToolHandler(server, contract, binding.unavailable);
  if (binding.provider !== undefined)
    return createProviderOperationToolHandler(
      server,
      binding.provider.operation,
      binding.provider,
      {
        logger,
        recordEvidence,
        evidenceById,
        withAdmittedAnalysis: requiredAdmission(
          withAdmittedAnalysis,
          contract.name,
        ),
      },
    )(contract);
  if (binding.mutation !== undefined)
    return createExternalMutationToolHandler(
      server,
      binding.session,
      binding.mutation,
      logger,
      retention,
    )(contract);
  if (binding.analyze !== undefined)
    return createAnalysisToolHandler(
      server,
      binding.analyze,
      logger,
      retention,
      requiredAdmission(withAdmittedAnalysis, contract.name),
      {
        detail: binding.detail,
        completionProgress: binding.completionProgress,
      },
    )(contract);
  if (binding.query !== undefined)
    return createValueToolHandler(
      server,
      analysisQuery(binding.query, contract.name),
      logger,
      requiredAdmission(withAdmittedAnalysis, contract.name),
      recordEvidence,
    )(contract);
  if (binding.value !== undefined)
    return createValueToolHandler(
      server,
      binding.value,
      logger,
      binding.admitted === true ? withAdmittedAnalysis : undefined,
      recordEvidence,
    )(contract);
  if (binding.workflow !== undefined)
    return createApplicationToolHandler(
      server,
      binding,
      logger,
      {
        recordEvidence,
        recordEvidenceWithUnknown,
        evidenceById,
      },
      withAdmittedAnalysis,
    )(contract);
  if (binding.derive !== undefined || binding.acquire !== undefined)
    return createDerivedToolHandler(
      server,
      binding.session,
      derivedAcquisition(binding),
      logger,
    )(contract);
  if (binding.run !== undefined)
    return createEvidenceToolHandler(
      server,
      binding.run,
      logger,
      recordEvidence,
      withAdmittedAnalysis,
      binding.viewSource,
    )(contract);
  return createRetainedSummaryToolHandler(
    server,
    contract as SummaryContract,
    binding,
    logger,
    retention,
    withAdmittedAnalysis,
  );
};

/**
 * Register each bound contract from the registry through the shared handler
 * its binding selects. A binding that names no registered contract is refused
 * at startup, so a renamed or removed contract cannot leave a dead handler.
 */
export const registerContractTools = (
  server: EvidenceMcpServer,
  bindings: ContractToolBindings,
  dependencies: ContractToolDependencies,
): void => {
  const retention: AnalysisViewRetention = {
    recordEvidence: dependencies.recordEvidence,
    evidenceById: dependencies.evidenceById,
  };
  // The table's exact per-name types are checked where it is written.
  const table: Readonly<Record<string, ErasedContractBinding | undefined>> =
    bindings as never;
  const matched: {
    readonly contract: CatalogContract;
    readonly index: number;
    readonly binding: ErasedContractBinding;
  }[] = [];
  const unbound: string[] = [];
  for (const name of Object.keys(table)) {
    const binding = table[name];
    if (binding === undefined) continue;
    const entry = toolContractEntry(name);
    if (entry === undefined) unbound.push(name);
    else
      matched.push({ contract: entry.contract, index: entry.index, binding });
  }
  matched.sort((left, right) => left.index - right.index);
  for (const { contract, binding } of matched) {
    if (
      binding.provider !== undefined &&
      binding.provider.operation !== contract.name
    )
      throw invariantViolation(
        `MCP tool ${contract.name} binds provider operation ${binding.provider.operation}`,
      );
    const registration =
      binding.admission === "sdk"
        ? toolRegistrationOptions(contract)
        : applicationToolRegistrationOptions(contract);
    const handler = createContractBindingHandler(
      server,
      contract,
      binding,
      dependencies,
      retention,
    );
    const present =
      binding.value === undefined ? undefined : binding.presentResult;
    server.registerTool(
      contract.name,
      registration,
      present === undefined
        ? handler
        : async (input: unknown, context: ServerContext) =>
            present(await handler(input, context)),
    );
  }
  if (unbound.length > 0)
    throw invariantViolation(
      `MCP tool bindings name no registered contract: ${unbound.join(", ")}`,
    );
};
