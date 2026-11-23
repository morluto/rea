import type { AnalysisSettings } from "../application/AnalysisSettings.js";
import { DEFAULT_MCP_MAX_INPUT_ELEMENTS } from "../config/mcpInputBudget.js";
import type {
  Implementation,
  Icon,
  McpServerOptions,
  RegisteredTool,
  RegisteredPrompt,
  ServerContext,
  PromptCallback,
  ScopeChallengeHandler,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
  Transport,
} from "@modelcontextprotocol/server";
import type { CompactInputSchemaPresentation } from "../contracts/compactInputSchema.js";
import {
  advertiseToolInput,
  type AdvertisedToolPresentation,
} from "../contracts/advertisedTool.js";
import type { createCatalogIdentity } from "../contracts/catalog/catalogIdentity.js";
import {
  hasGuaranteedObjectOutputRoot,
  omitAdvertisedOutputJsonSchema,
  transformAdvertisedInputJsonSchema,
} from "../contracts/toolSchemaMetadata.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { z } from "zod";
import {
  projectedErrorEncoding,
  type ToolResultDelivery,
} from "./ToolResultDelivery.js";
import { RequestTrackingMcpServer } from "./RequestTrackingMcpServer.js";
import { DISCOVER_TOOLS } from "../contracts/catalog/catalogDiscovery.js";
import { ProgressiveToolCatalog } from "./ProgressiveToolCatalog.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { canReferenceInlineEvidence } from "./evidenceInputRegistration.js";
import { currentMcpToolRequest } from "./McpToolRequest.js";
import type { PromptCompletionSource } from "./promptCompletion.js";
import {
  advertisedToolPresentation,
  resolveMcpOutputSchemaProfile,
  type McpOutputSchemaProfile,
  COMPACT_INPUT_SCHEMA_PRESENTATION,
} from "../contracts/mcpSchemaPresentation.js";
import { ErrorEvidenceTransport } from "./ErrorEvidenceTransport.js";
import { isRecord } from "../kernel/isRecord.js";

/** Capture caller selections and issues at the canonical SDK validation boundary. */
const captureInputValidation = <Schema extends StandardSchemaWithJSON>(
  tool: string,
  schema: Schema,
): Schema => {
  const standard = schema["~standard"];
  if (standard.vendor !== "zod") return schema;
  return {
    ...schema,
    "~standard": {
      ...standard,
      validate: (value: unknown) => {
        const context = currentMcpToolRequest();
        const capture = (
          result: Awaited<ReturnType<typeof standard.validate>>,
        ) => {
          if (context?.tool === tool && result.issues !== undefined)
            context.validation = {
              issues: result.issues as readonly z.core.$ZodIssue[],
              input: value,
            };
          if (result.issues === undefined)
            context?.captureCallerParameters(tool, value, result.value);
          return result;
        };
        const result = standard.validate(value);
        return result instanceof Promise
          ? result.then(capture)
          : capture(result);
      },
    },
  } as Schema;
};

/** A Zod schema whose standard interface exposes a JSON Schema projection. */
const hasAdvertisedInputJsonSchema = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const standard = Reflect.get(value, "~standard");
  if (typeof standard !== "object" || standard === null) return false;
  const jsonSchema = Reflect.get(standard, "jsonSchema");
  return (
    typeof jsonSchema === "object" &&
    jsonSchema !== null &&
    Reflect.get(jsonSchema, "input") !== undefined
  );
};

/** Standard-schema registration boundary shared with deferred SDK bindings. */
export interface StandardToolRegistration {
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: StandardSchemaWithJSON;
  readonly outputSchema?: StandardSchemaWithJSON;
  readonly annotations?: ToolAnnotations;
  readonly icons?: Icon[];
  readonly scopeChallenge?: ScopeChallengeHandler;
  readonly _meta?: Record<string, unknown>;
}

/** Lifecycle hook registered on {@link EvidenceMcpServerCore} for awaitable close. */
export interface ServerCloseHookOptions {
  /** Message used when wrapping failures in an {@link AggregateError}. */
  readonly failureMessage?: string | undefined;
  /** Wrap even a single failure in an {@link AggregateError} with `failureMessage`. */
  readonly alwaysAggregate?: boolean | undefined;
}

interface RegisteredCloseHook {
  readonly close: () => Promise<void>;
  readonly failureMessage: string | undefined;
  readonly alwaysAggregate: boolean;
}

/** Bind oversized MCP error recovery to this server's Evidence ledger. */
export class EvidenceMcpServerCore extends RequestTrackingMcpServer {
  private readonly registrations = new Map<string, RegisteredTool>();
  private readonly closeHooks: RegisteredCloseHook[] = [];
  private readonly transportCloseHooks: (() => void)[] = [];
  private transportOncloseInstalled = false;
  private progressiveCatalog: ProgressiveToolCatalog | undefined;
  private catalogChangeDepth = 0;
  private catalogChanged = false;
  analysisSettings: AnalysisSettings | undefined;
  /** Transport-owned Evidence uses the same lifetime as application writes. */
  withAdmittedAnalysis: WithAdmittedAnalysis | undefined;
  private identity: ReturnType<typeof createCatalogIdentity> | undefined;

  /** Register an awaitable cleanup hook settled during {@link close}. */
  registerCloseHook(
    close: () => Promise<void>,
    options: ServerCloseHookOptions = {},
  ): void {
    this.closeHooks.push({
      close,
      failureMessage: options.failureMessage,
      alwaysAggregate: options.alwaysAggregate === true,
    });
  }

  /** Register a synchronous cleanup notification fired when the transport closes. */
  registerTransportCloseHook(onClose: () => void): void {
    this.transportCloseHooks.push(onClose);
    if (this.transportOncloseInstalled) return;
    this.transportOncloseInstalled = true;
    const previousOnclose = this.server.onclose;
    this.server.onclose = () => {
      try {
        previousOnclose?.();
      } finally {
        for (const hook of this.transportCloseHooks) {
          try {
            hook();
          } catch {
            // Hooks own their own error logging; one failure must not block the rest.
          }
        }
      }
    };
  }

  /** Close only the underlying MCP protocol/transport without running registered hooks. */
  protected closeProtocol(): Promise<void> {
    return super.close();
  }

  /** Settle all registered close hooks without closing the underlying transport. */
  protected async closeRegisteredHooks(): Promise<void> {
    if (this.closeHooks.length === 0) return;
    await this.settleCloseTasks(this.closeHooks.map((hook) => hook.close()));
  }

  override async close(): Promise<void> {
    await this.settleCloseTasks([
      super.close(),
      ...this.closeHooks.map((hook) => hook.close()),
    ]);
  }

  private async settleCloseTasks(
    tasks: readonly Promise<void>[],
  ): Promise<void> {
    const results = await Promise.allSettled(tasks);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (failures.length === 0) return;
    const alwaysAggregateHook = [...this.closeHooks]
      .reverse()
      .find((hook) => hook.alwaysAggregate);
    if (alwaysAggregateHook !== undefined)
      throw new AggregateError(
        failures,
        alwaysAggregateHook.failureMessage ?? "REA server cleanup failed",
      );
    if (failures.length === 1) throw failures[0];
    const message =
      [...this.closeHooks]
        .reverse()
        .find((hook) => hook.failureMessage !== undefined)?.failureMessage ??
      "REA server cleanup failed";
    throw new AggregateError(failures, message);
  }

  /** Composition supplies identity without importing the canonical schema graph. */
  get catalogIdentity(): ReturnType<typeof createCatalogIdentity> {
    if (this.identity === undefined)
      throw new Error("MCP catalog identity has not been configured");
    return this.progressiveCatalog?.identity ?? this.identity;
  }

  /** Install discovery after canonical registrations, before connecting. */
  enableProgressiveCatalog(): void {
    if (this.progressiveCatalog !== undefined) return;
    const { name, ...config } = DISCOVER_TOOLS;
    // Transport discovery has no target or analysis lifecycle. Domain tools
    // continue through registerTool and their original named handlers. Its
    // advertisement still follows the selected input presentation.
    let catalog: ProgressiveToolCatalog | undefined;
    const adapter: RegisteredTool = super.registerTool(
      name,
      { ...config, ...this.presentInput(name, config) },
      (input, context) => {
        context.mcpReq.signal.throwIfAborted();
        if (catalog === undefined) {
          throw new Error("Progressive catalog is not yet initialized");
        }
        return catalog.discover(input);
      },
    );
    catalog = new ProgressiveToolCatalog(
      this.registrations,
      adapter,
      this.catalogIdentity,
      (change) => {
        this.catalogChangeDepth++;
        try {
          change();
        } finally {
          this.catalogChangeDepth--;
          if (this.catalogChangeDepth === 0 && this.catalogChanged) {
            this.catalogChanged = false;
            super.sendToolListChanged();
          }
        }
      },
      () => this.delivery,
    );
    this.progressiveCatalog = catalog;
  }

  override sendToolListChanged(): void {
    if (this.catalogChangeDepth > 0) this.catalogChanged = true;
    else super.sendToolListChanged();
  }

  /** Attach the process-owned session only after lazy runtime construction. */
  attachRuntime(
    recordEvidence: EvidenceWriter["recordEvidence"] | undefined,
    delivery: ToolResultDelivery,
    identity: ReturnType<typeof createCatalogIdentity>,
  ): void {
    if (
      this.identity !== undefined &&
      this.identity.digests.combined_sha256 !== identity.digests.combined_sha256
    )
      throw new Error("MCP catalog identity does not match runtime");
    this.recordEvidence = recordEvidence;
    this.delivery = delivery;
    this.identity = identity;
  }

  protected promptCompletion: PromptCompletionSource | undefined;
  bindPromptCompletion(
    completion: PromptCompletionSource,
  ): PromptCompletionSource {
    this.promptCompletion = completion;
    return completion;
  }

  registerCanonicalPrompt<Args extends StandardSchemaWithJSON>(
    name: string,
    config: { title?: string; description?: string; argsSchema: Args },
    callback: PromptCallback<Args>,
  ): RegisteredPrompt {
    return super.registerPrompt(name, config, callback);
  }
  private readonly presentation: AdvertisedToolPresentation;
  private readonly maximumInputElements: number;
  private readonly evidenceReferenceAlternatives = new Set<string>();

  protected registerEvidenceReferenceAlternative(name: string): void {
    this.evidenceReferenceAlternatives.add(name);
  }

  constructor(
    info: Implementation,
    options: McpServerOptions,
    private recordEvidence: EvidenceWriter["recordEvidence"] | undefined,
    public delivery: ToolResultDelivery,
    compactPresentation: CompactInputSchemaPresentation = COMPACT_INPUT_SCHEMA_PRESENTATION,
    outputSchemaProfile:
      | McpOutputSchemaProfile
      | "recorded" = resolveMcpOutputSchemaProfile(undefined),
    identity?: ReturnType<typeof createCatalogIdentity>,
    readonly advertisedToolFamilies:
      | ReadonlySet<string>
      | undefined = undefined,
    recordedTools?: ReadonlySet<string>,
  ) {
    const maximumInputElements =
      options.maxToolInputElements ?? DEFAULT_MCP_MAX_INPUT_ELEMENTS;
    super(info, { ...options, maxToolInputElements: maximumInputElements });
    this.maximumInputElements = maximumInputElements;
    this.presentation = advertisedToolPresentation(
      outputSchemaProfile,
      compactPresentation,
      recordedTools,
    );
    this.identity = identity;
  }

  /**
   * Compact advertised input schemas and bound or omit output-schema
   * advertisements. Canonical parsers and contracts remain registered; both
   * output profiles validate successful structured results locally.
   * The signatures mirror the SDK's registrations so call sites keep their
   * inferred handler argument types.
   */
  override registerTool<
    OutputArgs extends StandardSchemaWithJSON,
    InputArgs extends StandardSchemaWithJSON | undefined = undefined,
  >(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: InputArgs;
      outputSchema?: OutputArgs;
      annotations?: ToolAnnotations;
      icons?: Icon[];
      scopeChallenge?: ScopeChallengeHandler;
      _meta?: Record<string, unknown>;
    },
    callback: ToolCallback<InputArgs>,
  ): RegisteredTool {
    if (canReferenceInlineEvidence(config.inputSchema))
      this.registerEvidenceReferenceAlternative(name);
    const advertised = this.advertisesTool(name);
    const presented = advertised ? this.presentInput(name, config) : config;
    const outputSchema =
      this.presentation.output === undefined &&
      config.outputSchema !== undefined &&
      hasGuaranteedObjectOutputRoot(config.outputSchema)
        ? omitAdvertisedOutputJsonSchema(config.outputSchema)
        : config.outputSchema;
    const registeredConfig = advertised
      ? {
          ...config,
          ...(presented.description === undefined
            ? {}
            : { description: presented.description }),
          ...(presented.inputSchema === undefined
            ? {}
            : {
                inputSchema: captureInputValidation(
                  name,
                  presented.inputSchema as StandardSchemaWithJSON,
                ),
              }),
          ...(outputSchema === undefined ? {} : { outputSchema }),
        }
      : outputSchema === undefined
        ? config
        : { ...config, outputSchema };
    const scoped = async (input: never, context: never) => {
      const request = currentMcpToolRequest();
      request?.beginHandler();
      try {
        const normalized = (original: ServerContext): ServerContext =>
          request === undefined
            ? original
            : {
                ...original,
                mcpReq: {
                  ...original.mcpReq,
                  signal: AbortSignal.any([
                    request.cancellation.signal,
                    original.mcpReq.signal,
                  ]),
                },
              };
        const invoke = () =>
          config.inputSchema === undefined
            ? (callback as ToolCallback<undefined>)(
                normalized(input as ServerContext),
              )
            : (callback as ToolCallback<StandardSchemaWithJSON>)(
                input,
                normalized(context as ServerContext),
              );
        const result = await (this.analysisSettings === undefined
          ? invoke()
          : this.analysisSettings.run(invoke));
        if (request !== undefined)
          request.projectedErrorEncoding = projectedErrorEncoding(result);
        return result;
      } finally {
        request?.finishHandler();
      }
    };
    const registered = this.bindTool(
      name,
      registeredConfig as never,
      scoped as never,
    );
    if (!advertised) registered.disable();
    return registered;
  }

  /**
   * The input schema and tool description this server advertises for one
   * registration: the compact presentation, whose guidance joins the
   * description. A registration without an input schema is unchanged. Every
   * listed tool, including
   * transport discovery, takes this one path.
   */
  private presentInput<Schema>(
    name: string,
    config: { readonly description?: string; readonly inputSchema?: Schema },
  ): { description?: string; inputSchema?: Schema } {
    const { description, inputSchema } = config;
    const { input } = this.presentation;
    if (inputSchema === undefined || !hasAdvertisedInputJsonSchema(inputSchema))
      return config;
    let draft2020:
      | {
          readonly description: string | undefined;
          readonly inputSchema: Record<string, unknown> | undefined;
        }
      | undefined;
    const projectDraft2020 = () => {
      if (draft2020 !== undefined) return draft2020;
      const projected = (inputSchema as StandardSchemaWithJSON)[
        "~standard"
      ].jsonSchema.input({ target: "draft-2020-12" });
      draft2020 = isRecord(projected)
        ? advertiseToolInput(description, projected, input)
        : { description, inputSchema: undefined };
      return draft2020;
    };
    return {
      ...this.describeTool(name, () => projectDraft2020().description),
      inputSchema: transformAdvertisedInputJsonSchema(
        inputSchema,
        (projected) =>
          advertiseToolInput(description, projected, input).inputSchema,
        (target) =>
          target === "draft-2020-12"
            ? projectDraft2020().inputSchema
            : undefined,
      ),
    };
  }

  /**
   * The listed description: guidance the compact input schema omits follows
   * the registered description. Reading it projects the schema.
   */
  protected describeTool(
    _name: string,
    advertised: () => string | undefined,
  ): { description?: string } {
    const described = advertised();
    return described === undefined ? {} : { description: described };
  }

  /** Whether this process advertises one named operation. */
  advertisesTool(_name: string): boolean {
    return true;
  }

  /** Provider probes consult the registration scope before doing work. */
  advertisesFamily(family: string): boolean {
    return (
      this.advertisedToolFamilies === undefined ||
      this.advertisedToolFamilies.has(family)
    );
  }

  protected bindTool(
    name: string,
    config: StandardToolRegistration,
    callback: ToolCallback<StandardSchemaWithJSON | undefined>,
  ): RegisteredTool {
    const registered = super.registerTool(
      name,
      config as never,
      callback as never,
    );
    this.registrations.set(name, registered);
    return registered;
  }

  /** Preserve the SDK transport lifecycle while retaining oversized errors. */
  override connect(transport: Transport): Promise<void> {
    // HTTP reuses the analysis server after draining the previous transport.
    // Reset visibility while disconnected, before the next initialize/list.
    if (!this.isConnected()) this.progressiveCatalog?.reset();
    return super.connect(
      new ErrorEvidenceTransport(
        transport,
        () => this.recordEvidence,
        () => this.delivery,
        () => this.withAdmittedAnalysis,
        this.presentation.output,
        this.maximumInputElements,
        this.evidenceReferenceAlternatives,
      ),
    );
  }
}
