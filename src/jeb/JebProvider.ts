import { z } from "zod";
import type { JebAnalysisPort } from "../application/jeb/JebAnalysisPort.js";
import type {
  AnalysisExecution,
  ExecutionOptions,
  ProviderAvailability,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import { createAnalysisExecution } from "../application/AnalysisProvider.js";
import type { JebOperation, JebRequest } from "../domain/jeb/jebAnalysis.js";
import { jebResultSchemas } from "../domain/jeb/jebAnalysis.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisProtocolError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  parseJebMcpEndpoint,
  DEFAULT_JEB_MCP_ENDPOINT,
} from "./JebMcpEndpoint.js";
import {
  createStreamableHttpJebMcpConnection,
  type JebMcpConnection,
  type JebMcpConnectionFactory,
} from "./JebMcpConnection.js";

export const JEB_PROVIDER_IDENTITY: ProviderIdentity = {
  id: "jeb",
  name: "JEB",
  version: null,
} as const;

export interface JebProviderOptions {
  /** Caller environment carrying REA_JEB_MCP_URL. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Injectable MCP boundary; defaults to the streamable HTTP client. */
  readonly connectionFactory?: JebMcpConnectionFactory;
}

/** JEB's tool envelope: success with typed fields, or a message-only failure. */
const failure = z
  .object({
    success: z.literal(false),
    message: z.string().optional(),
    error: z
      .object({
        code: z.string().optional(),
        message: z.string().optional(),
        recovery_tool: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();
const clientInformation = z
  .object({
    success: z.literal(true),
    version: z.string().optional(),
    gui_client: z.boolean().optional(),
    startup_ts: z.number().int().nonnegative().optional(),
    message: z.string().nullish(),
  })
  .passthrough();
const unitEntry = z.object({ unit_path: z.string(), unit_type: z.string() });
const openProject = z
  .object({
    success: z.literal(true),
    name: z.string().nullish(),
    creation_datetime: z.string().nullish(),
    input_files: z
      .array(
        z.object({
          file_name: z.string(),
          file_size: z.number().int().nonnegative(),
          contents_sha256_hash: z.string(),
        }),
      )
      .optional(),
    units: z.array(unitEntry).optional(),
  })
  .passthrough();
const listUnits = z
  .object({ success: z.literal(true), units: z.array(unitEntry) })
  .passthrough();
const decompiledItem = z
  .object({ success: z.literal(true), text: z.string() })
  .passthrough();

const refusalReason = (payload: unknown, fallback: string): string => {
  const parsed = failure.safeParse(payload);
  if (!parsed.success) return fallback;
  const envelope = parsed.data;
  const reason =
    envelope.error?.message ?? envelope.message ?? envelope.error?.code;
  if (reason !== undefined && reason.length > 0) return reason;
  return fallback;
};

/** Serve REA's JEB operations from a running engine client over MCP. */
export class JebProvider implements JebAnalysisPort {
  readonly #connection: JebMcpConnection;
  readonly #endpoint: URL;
  #identity: ProviderIdentity = JEB_PROVIDER_IDENTITY;
  #guiClient: boolean | null = null;

  constructor(options: JebProviderOptions = {}) {
    const environment = options.environment ?? {};
    const endpoint = parseJebMcpEndpoint(environment.REA_JEB_MCP_URL);
    if (!endpoint.ok) throw endpoint.error;
    this.#endpoint = endpoint.value;
    this.#connection = (
      options.connectionFactory ??
      ((url: URL) => createStreamableHttpJebMcpConnection(url))
    )(this.#endpoint);
  }

  async inspectAvailability(
    signal?: AbortSignal,
  ): Promise<ProviderAvailability> {
    try {
      await this.#refreshClientInformation(signal);
      return {
        status: "available",
        code: null,
        reason: null,
        diagnostics: {
          endpoint: this.#endpoint.toString(),
          engine_version: this.#identity.version,
        },
      };
    } catch (cause) {
      if (signal?.aborted === true) throw cause;
      return {
        status: "unavailable",
        code: "not_configured",
        reason:
          cause instanceof Error
            ? cause.message
            : "The JEB MCP endpoint did not respond",
        diagnostics: { endpoint: this.#endpoint.toString() },
      };
    }
  }

  async close(): Promise<void> {
    await this.#connection.close();
  }

  async execute(
    request: JebRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (options?.signal?.aborted === true)
      return err(new AnalysisCancelledError(request.operation));
    try {
      const execution = await this.#dispatch(request, options?.signal);
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(request.operation));
      if (execution.ok)
        this.#identity = {
          ...this.#identity,
          version: execution.value.provider.version,
        };
      return execution;
    } catch (cause) {
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(request.operation, { cause }));
      return err(this.#providerFailure(request.operation, cause));
    }
  }

  async #dispatch(
    request: JebRequest,
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const cancelled = (operation: JebOperation) => {
      if (signal?.aborted === true) throw new AnalysisCancelledError(operation);
    };
    switch (request.operation) {
      case "inspect_jeb_client": {
        cancelled(request.operation);
        return this.#inspectClient(signal);
      }
      case "open_jeb_project": {
        cancelled(request.operation);
        return this.#openProject(request, signal);
      }
      case "list_jeb_units": {
        cancelled(request.operation);
        return this.#listUnits(request, signal);
      }
      case "decompile_jeb_item": {
        cancelled(request.operation);
        return this.#decompileItem(request, signal);
      }
    }
  }

  async #engine(signal?: AbortSignal): Promise<{
    readonly name: string;
    readonly version: string | null;
    readonly endpoint: string;
    readonly gui_client: boolean | null;
  }> {
    await this.#requireClientInformation(signal);
    return {
      name: "jeb",
      version: this.#identity.version,
      endpoint: this.#endpoint.toString(),
      gui_client: this.#guiClient,
    };
  }

  async #requireClientInformation(signal?: AbortSignal): Promise<void> {
    if (this.#identity.version !== null) return;
    await this.#refreshClientInformation(signal);
  }

  async #refreshClientInformation(
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (signal?.aborted === true)
      throw new AnalysisCancelledError("inspect_jeb_client");
    const payload = await this.#connection.call(
      "get_client_information",
      {},
      signal,
    );
    const information = clientInformation.parse(
      this.#requireSuccess(payload, "inspect_jeb_client"),
    );
    this.#identity = {
      ...this.#identity,
      version: information.version ?? null,
    };
    this.#guiClient = information.gui_client ?? null;
  }

  async #inspectClient(signal?: AbortSignal) {
    const payload = await this.#connection.call(
      "get_client_information",
      {},
      signal,
    );
    const information = clientInformation.parse(
      this.#requireSuccess(payload, "inspect_jeb_client"),
    );
    this.#identity = {
      ...this.#identity,
      version: information.version ?? null,
    };
    this.#guiClient = information.gui_client ?? null;
    const result = jebResultSchemas.inspect_jeb_client.parse({
      engine: {
        name: "jeb",
        version: information.version ?? null,
        endpoint: this.#endpoint.toString(),
        gui_client: information.gui_client ?? null,
      },
      startup_ts: information.startup_ts ?? null,
      message: information.message ?? null,
    });
    return ok(
      createAnalysisExecution(result, this.#identity, {
        rawResult: payload,
        limitations:
          information.version === undefined
            ? ["The engine did not report its version."]
            : [],
      }),
    );
  }

  async #openProject(
    request: Extract<JebRequest, { operation: "open_jeb_project" }>,
    signal?: AbortSignal,
  ) {
    const payload = await this.#connection.call(
      "open_project",
      {
        file_path: request.input.path,
      },
      signal,
    );
    const opened = openProject.parse(
      this.#requireSuccess(payload, request.operation),
    );
    const engine = await this.#engine(signal);
    const result = jebResultSchemas.open_jeb_project.parse({
      engine,
      project_name: opened.name ?? null,
      creation_datetime: opened.creation_datetime ?? null,
      input_files: opened.input_files ?? [],
      units: opened.units ?? [],
    });
    return ok(
      createAnalysisExecution(result, this.#identity, {
        rawResult: payload,
        limitations: [
          "JEB resolves and analyzes the artifact on the engine host; REA did not open the target itself.",
        ],
      }),
    );
  }

  async #listUnits(
    request: Extract<JebRequest, { operation: "list_jeb_units" }>,
    signal?: AbortSignal,
  ) {
    const { count, index, filter, parent_unit_path } = request.input;
    const payload = await this.#connection.call(
      "list_units",
      {
        count,
        index,
        ...(filter === undefined ? {} : { filter }),
        ...(parent_unit_path === undefined ? {} : { parent_unit_path }),
      },
      signal,
    );
    const listed = listUnits.parse(
      this.#requireSuccess(payload, request.operation),
    );
    const units = listed.units;
    const engine = await this.#engine(signal);
    const result = jebResultSchemas.list_jeb_units.parse({
      engine,
      filter: filter ?? null,
      parent_unit_path: parent_unit_path ?? null,
      index,
      count,
      units,
      coverage: units.length < count ? "complete" : "partial",
    });
    return ok(
      createAnalysisExecution(result, this.#identity, {
        rawResult: payload,
        limitations: [
          "The engine caps unit pages at 100; a full page means more units may exist.",
        ],
      }),
    );
  }

  async #decompileItem(
    request: Extract<JebRequest, { operation: "decompile_jeb_item" }>,
    signal?: AbortSignal,
  ) {
    const { item_address, item_kind, unit_path } = request.input;
    const payload = await this.#connection.call(
      "decompile_code_item",
      {
        item_address,
        item_kind,
        ...(unit_path === undefined ? {} : { unit_path }),
      },
      signal,
    );
    const decompiled = decompiledItem.parse(
      this.#requireSuccess(payload, request.operation),
    );
    const engine = await this.#engine(signal);
    const result = jebResultSchemas.decompile_jeb_item.parse({
      engine,
      unit_path: unit_path ?? null,
      item_address,
      item_kind,
      text: decompiled.text,
    });
    return ok(
      createAnalysisExecution(result, this.#identity, {
        rawResult: payload,
        limitations:
          unit_path === undefined
            ? [
                "The engine selected the project's first code unit implicitly; the effective unit identity is unknown.",
              ]
            : [],
      }),
    );
  }

  #requireSuccess(payload: unknown, operation: JebOperation): unknown {
    if (typeof payload !== "object" || payload === null)
      throw new AnalysisProtocolError(
        "JEB MCP returned a non-object envelope; no observation can be established",
      );
    const success = (payload as { success?: unknown }).success;
    if (success === false)
      throw new AnalysisUnsupportedTargetError(
        operation,
        this.#endpoint.toString(),
        refusalReason(payload, "The engine refused the request"),
      );
    if (success !== true)
      throw new AnalysisProtocolError(
        "JEB MCP omitted its success field; no observation can be established",
      );
    return payload;
  }

  #providerFailure(operation: JebOperation, cause: unknown): AnalysisError {
    if (cause instanceof AnalysisError) return cause;
    if (cause instanceof z.ZodError)
      return new AnalysisProtocolError(
        "JEB omitted or malformed required observation fields",
        { cause },
      );
    return new AnalysisCapabilityUnavailableError(
      "jeb",
      operation,
      cause instanceof Error ? cause.message : String(cause),
      {
        cause: cause instanceof Error ? cause : undefined,
        userMessage: `Start a JEB client serving MCP (default ${DEFAULT_JEB_MCP_ENDPOINT}) or set REA_JEB_MCP_URL to the running endpoint.`,
      },
    );
  }
}
