import { realpath } from "node:fs/promises";
import { z } from "zod";
import {
  ABORTED,
  waitForAbortable,
} from "../application/binary/AbortablePromise.js";
import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisProtocolError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { createEvidence } from "../domain/evidence.js";
import type { AngrConfiguration } from "./AngrConfiguration.js";
import type { AngrMcpConnection } from "./AngrMcpConnection.js";
import { parseAngrInput } from "./AngrInput.js";
import {
  AngrOperationRunner,
  type AngrRawObservation,
} from "./AngrOperationRunner.js";
import {
  ANGR_FLAVOR_TOOLS,
  ANGR_LIMITATIONS,
  ANGR_OPERATIONS,
  ANGR_PROVIDER_IDENTITY,
  ANGR_REQUIRED_TOOLS,
  type AngrOperation,
} from "./AngrProviderCapabilities.js";
import {
  angrLoadOptions,
  cfgStatsSchema,
  closeProjectSchema,
  flavorSchema,
  loadBinarySchema,
  type AngrCallGraph,
  type AngrLoadedBinary,
} from "./AngrProtocolValues.js";

const operationSet: ReadonlySet<string> = new Set(ANGR_OPERATIONS);
const isAngrOperation = (operation: string): operation is AngrOperation =>
  operationSet.has(operation);
const wasCancelled = (options: ExecutionOptions | undefined): boolean =>
  options?.signal?.aborted === true;

/** A failed cleanup retains the upstream project and reports it for retry. */
class AngrCleanupError extends ProviderAdapterError {
  override readonly cleanupIncomplete = true;
  override readonly cleanupResources: readonly string[];
  constructor(resource: string, cause: unknown) {
    super("angr", "close", {
      cause,
      diagnostics: {
        reason:
          "angr cleanup could not be verified; the upstream project or connection is retained for retry.",
        failure_reason: cause instanceof Error ? cause.message : String(cause),
        resource,
      },
    });
    this.cleanupResources = [resource];
  }
}

/** Serial read-only session over one angr project loaded for the bound target. */
export class AngrSessionClient implements AnalysisClient {
  #tail: Promise<void> = Promise.resolve();
  #startup: Promise<void> | undefined;
  #closed = false;
  #closing = false;
  #closePromise: Promise<Result<null, AnalysisError>> | undefined;
  #loaded: AngrLoadedBinary | undefined;
  /** Retained as soon as the server reports it, so a failed startup can still close the project. */
  #projectId: string | undefined;
  #cfg: JsonValue = null;
  #callGraph:
    | Promise<{ graph: AngrCallGraph; observation: AngrRawObservation }>
    | undefined;
  #flavor: string | null = null;
  #flavorToolsAvailable = false;
  /** Session-wide limitations established at startup. */
  readonly #limitations: string[] = [];

  constructor(
    private readonly config: AngrConfiguration,
    private readonly target: BinaryTarget,
    private readonly connection: AngrMcpConnection,
    private readonly profile?: AnalysisProfileCommitment,
  ) {}

  execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    const call = this.#tail.then(() =>
      this.#execute(operation, parameters, options),
    );
    this.#tail = call.then(
      () => undefined,
      () => undefined,
    );
    return call;
  }

  async executeIfReady(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    if (this.#loaded === undefined || this.#closed || this.#closing)
      return undefined;
    const call = this.#tail.then(() => {
      if (this.#loaded === undefined || this.#closed || this.#closing)
        return undefined;
      if (wasCancelled(options))
        return err(new AnalysisCancelledError(operation));
      return this.#execute(operation, parameters, options);
    });
    this.#tail = call.then(
      () => undefined,
      () => undefined,
    );
    const result = await waitForAbortable(call, options?.signal);
    return result === ABORTED
      ? err(new AnalysisCancelledError(operation))
      : result;
  }

  async #execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    if (this.#closed || this.#closing)
      return err(
        new AnalysisProtocolError(
          "angr session is closing or closed; reopen the target.",
        ),
      );
    if (wasCancelled(options))
      return err(new AnalysisCancelledError(operation));
    if (operation !== "health" && !isAngrOperation(operation))
      return err(
        new AnalysisCapabilityUnavailableError(
          "angr",
          operation,
          "This integration admits read-only static analysis operations only.",
        ),
      );
    if (operation !== "health") {
      const parsed = parseAngrInput(operation, parameters);
      if (!parsed.ok) return parsed;
      parameters = parsed.value;
    }
    let runner: AngrOperationRunner | undefined;
    try {
      await this.#start();
      if (wasCancelled(options)) throw new AnalysisCancelledError(operation);
      if (operation === "health") return this.#health();
      if (!isAngrOperation(operation))
        throw new AnalysisProtocolError(
          "angr operation changed after validation.",
        );
      runner = this.#runner(options);
      const result = await runner.run(operation, parameters);
      if (wasCancelled(options)) throw new AnalysisCancelledError(operation);
      return ok(
        createAnalysisExecution(result, ANGR_PROVIDER_IDENTITY, {
          rawResult: {
            upstream: this.connection.serverInfo(),
            project: jsonValueSchema.parse(this.#loaded ?? null),
            decompilation_flavor:
              this.config.mode === "attached" ? null : this.#flavor,
            observations: jsonValueSchema.parse(runner.raw),
          },
          limitations: [
            ...ANGR_LIMITATIONS,
            ...this.#limitations,
            ...new Set(runner.limitations),
          ],
          ...(runner.relationshipCoverage === undefined
            ? {}
            : { relationshipCoverage: runner.relationshipCoverage }),
          locations: [
            { kind: "artifact-path", path: this.target.path },
            ...runner.locations,
          ],
          ...(this.profile === undefined
            ? {}
            : { analysisProfile: this.profile }),
        }),
      );
    } catch (cause: unknown) {
      return this.#failure(operation, cause, options, { runner, parameters });
    }
  }

  #runner(options: ExecutionOptions | undefined): AngrOperationRunner {
    if (this.#loaded === undefined)
      throw new AnalysisProtocolError("angr session has no loaded project.");
    return new AngrOperationRunner(this.connection, this.#loaded.project_id, {
      signal: options?.signal,
      selectorOrigin: options?.selectorOrigin,
      callGraph: async (runner) => {
        if (this.config.mode === "attached" || this.#callGraph === undefined) {
          // Attached projects are shared; another client can change names or
          // graph facts between requests, so only owned sessions may cache.
          this.#callGraph = runner.loadCallGraph().catch((cause: unknown) => {
            this.#callGraph = undefined;
            throw cause;
          });
          const loaded = await this.#callGraph;
          if (this.config.mode === "attached") this.#callGraph = undefined;
          return loaded.graph;
        }
        // A cache hit replays the reply so this result's Evidence explains its relationships.
        const cached = await this.#callGraph;
        if (!runner.raw.some(({ tool }) => tool === "get_callgraph"))
          runner.raw.push({ ...cached.observation, reused: true });
        return cached.graph;
      },
      flavorToolsAvailable: this.#flavorToolsAvailable,
      // Call-graph nodes carry function names, so any applied edit invalidates it.
      onMutation: () => {
        this.#callGraph = undefined;
      },
      onFlavor: (flavor) => {
        this.#flavor = flavor;
      },
    });
  }

  #health() {
    return ok(
      createAnalysisExecution(
        {
          ready: this.#loaded !== undefined,
          mode: this.config.mode,
          project: jsonValueSchema.parse(this.#loaded ?? null),
          cfg: this.#cfg,
          decompilation_flavor:
            this.config.mode === "attached" ? null : this.#flavor,
          upstream: this.connection.serverInfo(),
        },
        ANGR_PROVIDER_IDENTITY,
        {
          limitations: ANGR_LIMITATIONS,
          ...(this.profile === undefined
            ? {}
            : { analysisProfile: this.profile }),
        },
      ),
    );
  }

  #failure(
    operation: string,
    cause: unknown,
    options: ExecutionOptions | undefined,
    context: {
      readonly runner: AngrOperationRunner | undefined;
      readonly parameters: Readonly<Record<string, JsonValue>>;
    },
  ) {
    const { runner, parameters } = context;
    let failure: AnalysisError;
    if (
      cause instanceof AnalysisError &&
      (cause.partialObservation !== undefined ||
        cause.cleanupIncomplete ||
        cause.capturedOutput !== undefined)
    )
      failure = cause;
    else if (wasCancelled(options))
      failure = new AnalysisCancelledError(operation);
    else if (cause instanceof AnalysisError) failure = cause;
    else if (cause instanceof z.ZodError)
      failure = new AnalysisOutputError(
        operation,
        `angr MCP returned malformed or unsupported producer data: ${cause.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ")}`,
        { cause },
      );
    else
      failure = new ProviderAdapterError("angr", operation, {
        cause,
        diagnostics: {
          reason:
            cause instanceof Error ? cause.message : "Unknown upstream failure",
          recovery:
            "Check the configured angr interpreter or MCP registration and the selected target; see docs/angr-provider.md.",
        },
      });
    if (runner !== undefined && runner.raw.length > 0) {
      const observations = jsonValueSchema.parse(runner.raw);
      failure.retainPartialObservation(
        createEvidence(this.target, ANGR_PROVIDER_IDENTITY, {
          predicateType: "analysis-observation",
          operation,
          parameters,
          result: {
            status: "partial",
            failed_operation: operation,
            observations,
            project: jsonValueSchema.parse(this.#loaded ?? null),
          },
          rawResult: {
            upstream: this.connection.serverInfo(),
            observations,
            project: jsonValueSchema.parse(this.#loaded ?? null),
          },
          confidence: "observed",
          authority: "external-service",
          ...(this.profile === undefined
            ? {}
            : { analysisProfile: this.profile }),
          limitations: [
            ...ANGR_LIMITATIONS,
            ...this.#limitations,
            ...new Set(runner.limitations),
            "The requested angr operation failed after these completed upstream replies; the partial Evidence does not establish a complete result.",
          ],
          locations: [
            { kind: "artifact-path", path: this.target.path },
            ...runner.locations,
          ],
        }),
      );
    }
    return err(failure);
  }

  #start(): Promise<void> {
    this.#startup ??= this.#initialize();
    return this.#startup;
  }

  async #initialize(): Promise<void> {
    const tools = new Set(await this.connection.connect());
    const missing = ANGR_REQUIRED_TOOLS.filter((name) => !tools.has(name));
    if (missing.length > 0)
      throw new AnalysisProtocolError(
        `angr MCP server is missing tools: ${missing.join(", ")}. Install a current angr release with its MCP extra; see docs/angr-provider.md.`,
      );
    const reply = await this.#loadBinary();
    this.#projectId = z
      .object({ project_id: z.string().min(1) })
      .parse(reply).project_id;
    const loaded = loadBinarySchema.parse(reply);
    this.#loaded = loaded;
    await this.#verifyLoadedTarget(loaded);
    const cfg = cfgStatsSchema.parse(
      await this.connection.call(
        "get_cfg",
        {
          project_id: loaded.project_id,
          normalize: true,
          data_references: true,
        },
        { timeoutMs: this.config.startupTimeoutMs },
      ),
    );
    if (cfg.project_id !== loaded.project_id)
      throw new AnalysisProtocolError(
        "angr CFG recovery answered for a different project than the loaded target.",
      );
    this.#cfg = jsonValueSchema.parse(cfg);
    this.#flavorToolsAvailable = ANGR_FLAVOR_TOOLS.every((name) =>
      tools.has(name),
    );
    if (this.#flavorToolsAvailable) {
      const current = flavorSchema.parse(
        await this.connection.call("get_decompilation_flavor", {
          project_id: loaded.project_id,
        }),
      );
      this.#flavor = current.flavor;
    }
    if (this.config.flavor !== undefined) {
      if (!this.#flavorToolsAvailable)
        throw new AnalysisProtocolError(
          `The angr registration selects flavor ${this.config.flavor}, but the connected server has no decompilation-flavor tools; upgrade angr or remove the flavor setting.`,
        );
      const changed = flavorSchema.parse(
        await this.connection.call("set_decompilation_flavor", {
          project_id: loaded.project_id,
          flavor: this.config.flavor,
        }),
      );
      this.#flavor = changed.flavor;
    }
  }

  /** Headered files load as-is; supported raw images carry REA's loader selection to angr. */
  async #loadBinary(): Promise<JsonValue> {
    const options = angrLoadOptions(this.target);
    try {
      return await this.connection.call(
        "load_binary",
        {
          binary_path: this.target.path,
          auto_load_libs: this.config.autoLoadLibs,
          ...options,
        },
        { timeoutMs: this.config.startupTimeoutMs },
      );
    } catch (cause: unknown) {
      if (
        Object.keys(options).length > 0 &&
        cause instanceof AnalysisProtocolError &&
        /Unexpected keyword argument/u.test(cause.message)
      )
        throw new AnalysisProtocolError(
          `The connected angr MCP server does not accept loader options (${Object.keys(options).join(", ")}); upgrade angr to load ${this.target.format} targets.`,
          { cause },
        );
      throw cause;
    }
  }

  /**
   * A reported digest proves identity across filesystem views; without one,
   * only a server sharing this host's filesystem can be checked, by path.
   */
  async #verifyLoadedTarget(loaded: AngrLoadedBinary): Promise<void> {
    if (loaded.sha256 !== undefined) {
      if (loaded.sha256.toLowerCase() !== this.target.sha256.toLowerCase())
        throw new AnalysisProtocolError(
          `angr loaded a file whose SHA-256 ${loaded.sha256} differs from the selected target ${this.target.path}.`,
        );
      return;
    }
    const [expected, reported] = await Promise.all([
      realpath(this.target.path).catch(() => this.target.path),
      realpath(loaded.binary_path).catch(() => loaded.binary_path),
    ]);
    if (expected !== reported)
      throw new AnalysisProtocolError(
        `angr loaded ${loaded.binary_path} instead of the selected target ${this.target.path}. This angr reports no file digest, so the server must share this host's filesystem; upgrade angr for digest-based verification.`,
      );
    this.#limitations.push(
      "The connected angr reports no file digest; target identity was verified by path on this host only.",
    );
  }

  async close(): Promise<Result<null, AnalysisError>> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    const closing = this.#closeOnce();
    const shared = closing.finally(() => {
      if (this.#closePromise === shared) this.#closePromise = undefined;
    });
    this.#closePromise = shared;
    return shared;
  }

  async #closeOnce(): Promise<Result<null, AnalysisError>> {
    this.#closing = true;
    await this.#tail;
    if (this.#closed) return ok(null);
    const resource =
      this.#projectId === undefined
        ? "angr MCP connection"
        : `angr project ${this.#projectId}`;
    try {
      if (this.#startup !== undefined) {
        // A failed startup may still have loaded the project before CFG recovery.
        await this.#startup.catch(() => undefined);
        const transportClosed = await this.#closeProject();
        if (!transportClosed) await this.connection.close();
      }
      this.#closed = true;
      return ok(null);
    } catch (cause: unknown) {
      return err(new AngrCleanupError(resource, cause));
    }
  }

  /** Closes the loaded project; true when the owned transport was ended to release it. */
  async #closeProject(): Promise<boolean> {
    const projectId = this.#projectId;
    if (projectId === undefined) return false;
    try {
      const closed = closeProjectSchema.parse(
        await this.connection.call("close_project", {
          project_id: projectId,
        }),
      );
      if (closed.project_id !== projectId)
        throw new AnalysisProtocolError(
          "angr closed a different project than the one this session loaded.",
        );
    } catch (cause: unknown) {
      // A shared (attached) server keeps the project for a later retry, even
      // behind a stdio proxy. An owned headless server holds it only in
      // memory, so ending the process releases it.
      if (this.config.mode === "attached") {
        const detached = this.connection.detach?.();
        if (detached === undefined || !detached.ok)
          throw new AggregateError(
            [cause, ...(detached === undefined ? [] : [detached.error])],
            "angr project close failed and its retained transport could not be detached.",
          );
        throw cause;
      }
      await this.connection.close();
      this.#loaded = undefined;
      this.#projectId = undefined;
      return true;
    }
    this.#loaded = undefined;
    this.#projectId = undefined;
    return false;
  }
}
