import { z } from "zod";
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
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type { IdaConfiguration } from "./IdaConfiguration.js";
import type { IdaMcpConnection } from "./IdaMcpConnection.js";
import { IdaOperationRunner } from "./IdaOperationRunner.js";
import {
  IDA_LIMITATIONS,
  IDA_OPERATIONS,
  IDA_PROVIDER_IDENTITY,
  type IdaOperation,
} from "./IdaProviderCapabilities.js";
import {
  closeDatabaseSchema,
  databaseListSchema,
  legacyMetadataSchema,
  modernHealthSchema,
  openDatabaseSchema,
} from "./IdaProtocolValues.js";
import {
  idaFileDigest,
  IdaWorkspace,
  sameIdaHostPath,
} from "./IdaWorkspace.js";
import { parseIdaInput } from "./IdaInput.js";

const legacyTools = [
  "get_metadata",
  "list_functions",
  "list_strings",
  "get_function_by_name",
  "get_function_by_address",
  "decompile_function",
  "disassemble_function",
  "get_callers",
  "get_callees",
  "get_xrefs_to",
];
const modernTools = [
  "idb_open",
  "idb_list",
  "idb_close",
  "server_health",
  "list_funcs",
  "lookup_funcs",
  "find_regex",
  "decompile",
  "disasm",
  "callees",
  "xrefs_to",
];
const operationSet: ReadonlySet<string> = new Set(IDA_OPERATIONS);
const isIdaOperation = (operation: string): operation is IdaOperation =>
  operationSet.has(operation);
const wasCancelled = (options: ExecutionOptions | undefined): boolean =>
  options?.signal?.aborted === true;

/** A failed cleanup retains its private workspace and reports the remaining resource. */
class IdaCleanupError extends ProviderAdapterError {
  override readonly cleanupIncomplete = true;
  override readonly cleanupResources: readonly string[];
  constructor(path: string, cause: unknown) {
    super("ida", "close", {
      cause,
      diagnostics: {
        reason:
          "IDA worker release could not be verified. The private workspace was retained.",
        workspace: path,
      },
    });
    this.cleanupResources = [path];
  }
}

/** Serial read-only session whose lifecycle authority excludes an attached GUI. */
export class IdaSessionClient implements AnalysisClient {
  #tail: Promise<void> = Promise.resolve();
  #startup: Promise<void> | undefined;
  #closed = false;
  #closing = false;
  #closePromise: Promise<Result<null, AnalysisError>> | undefined;
  #workspace: IdaWorkspace | undefined;
  #database: string | undefined;
  #openAttempted = false;
  #openCompleted = false;
  #initialIdentity: string | undefined;
  #metadata: JsonValue = null;
  #lifecycle: JsonValue[] = [];

  constructor(
    private readonly config: IdaConfiguration,
    private readonly target: BinaryTarget,
    private readonly connection: IdaMcpConnection,
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

  async #execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    if (this.#closed || this.#closing)
      return err(
        new AnalysisProtocolError(
          "IDA session is closing or closed; reopen the target.",
        ),
      );
    if (wasCancelled(options))
      return err(new AnalysisCancelledError(operation));
    if (operation !== "health" && !isIdaOperation(operation))
      return err(
        new AnalysisCapabilityUnavailableError(
          "ida",
          operation,
          "This integration admits read-only analysis operations only.",
        ),
      );
    if (operation === "procedure_callers" && this.config.mode === "headless")
      return err(
        new AnalysisCapabilityUnavailableError(
          "ida",
          operation,
          "The modern upstream profile does not prove direct callers.",
        ),
      );
    if (operation !== "health") {
      const parsed = parseIdaInput(operation, parameters);
      if (!parsed.ok) return parsed;
      parameters = parsed.value;
    }
    const document = parameters.document;
    if (
      document !== undefined &&
      document !== this.target.path &&
      document !== this.target.sourcePath
    )
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: ["document"],
            reason: "invalid_value",
            expected: this.target.path,
            message:
              "IDA document must be the REA-bound target; omit document or use its admitted path.",
          },
        ]),
      );
    try {
      await this.#start();
      const before = await this.#observe();
      if (wasCancelled(options))
        return err(new AnalysisCancelledError(operation));
      if (operation === "health") return this.#health(before);
      if (!isIdaOperation(operation))
        throw new AnalysisProtocolError(
          "IDA operation changed after validation.",
        );
      const runner = new IdaOperationRunner(
        this.connection,
        this.config.mode === "attached" ? "legacy" : "modern",
        this.#database,
      );
      const result = await runner.run(operation, parameters);
      const after = await this.#observe();
      if (wasCancelled(options))
        return err(new AnalysisCancelledError(operation));
      return ok(
        createAnalysisExecution(result, IDA_PROVIDER_IDENTITY, {
          rawResult: {
            upstream: this.connection.serverInfo(),
            metadata_before: before,
            metadata_after: after,
            observations: jsonValueSchema.parse(runner.raw),
          },
          limitations: [...IDA_LIMITATIONS, ...runner.limitations],
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
      return this.#failure(operation, cause, options);
    }
  }

  #health(metadata: JsonValue) {
    return ok(
      createAnalysisExecution(
        {
          ready: true,
          mode: this.config.mode,
          database: this.#database ?? null,
          upstream: this.connection.serverInfo(),
          metadata,
          lifecycle: this.#lifecycle,
        },
        IDA_PROVIDER_IDENTITY,
        {
          limitations: IDA_LIMITATIONS,
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
  ) {
    if (wasCancelled(options))
      return err(new AnalysisCancelledError(operation));
    if (cause instanceof AnalysisError) return err(cause);
    if (cause instanceof z.ZodError)
      return err(
        new AnalysisOutputError(
          operation,
          `IDA MCP returned malformed or unsupported producer data: ${cause.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ")}`,
          { cause },
        ),
      );
    return err(
      new ProviderAdapterError("ida", operation, {
        cause,
        diagnostics: {
          reason:
            cause instanceof Error ? cause.message : "Unknown upstream failure",
          recovery:
            "Check the configured upstream MCP registration and selected target; see docs/ida-provider.md.",
        },
      }),
    );
  }

  #start(): Promise<void> {
    this.#startup ??= this.#initialize();
    return this.#startup;
  }

  async #initialize(): Promise<void> {
    const tools = new Set(await this.connection.connect());
    const expected =
      this.config.mode === "attached" ? legacyTools : modernTools;
    const missing = expected.filter((name) => !tools.has(name));
    if (missing.length > 0)
      throw new AnalysisProtocolError(
        `IDA MCP ${this.config.mode} compatibility profile is missing tools: ${missing.join(", ")}. Attached mode requires the legacy 1.4 profile; headless mode requires the database supervisor profile. See docs/ida-provider.md.`,
      );
    if (this.config.mode === "headless") {
      this.#workspace = await IdaWorkspace.create(
        this.target,
        this.config.workspaceRoot,
      );
      this.#openAttempted = true;
      const raw = await this.connection.call("idb_open", {
        input_path: this.#workspace.inputPath,
        mode: "force_headless",
        run_auto_analysis: true,
        build_caches: true,
        init_hexrays: true,
        preferred_session_id: this.#workspace.sessionId,
      });
      this.#openCompleted = true;
      this.#lifecycle.push(raw);
      const opened = openDatabaseSchema.parse(raw);
      if (
        !sameIdaHostPath(opened.session.input_path, this.#workspace.inputPath)
      )
        throw new AnalysisProtocolError(
          "IDA opened a different input than the private admitted target copy.",
        );
      if (opened.session.session_id !== this.#workspace.sessionId)
        throw new AnalysisProtocolError(
          "IDA returned an adopted or unexpected session instead of the requested private worker.",
        );
      const inventory = databaseListSchema.parse(
        await this.connection.call("idb_list", {}),
      );
      this.#lifecycle.push(jsonValueSchema.parse(inventory));
      const entry = inventory.sessions.find(
        ({ session_id }) => session_id === opened.session.session_id,
      );
      if (
        entry?.owned !== true ||
        entry.backend !== "worker" ||
        entry.is_active !== true ||
        !sameIdaHostPath(entry.input_path, this.#workspace.inputPath)
      )
        throw new AnalysisProtocolError(
          "IDA did not return an active owned headless worker for the private input copy.",
        );
      this.#database = opened.session.session_id;
    }
  }

  async #observe(): Promise<JsonValue> {
    let identity: string;
    if (this.config.mode === "attached") {
      const raw = await this.connection.call("get_metadata", {});
      const metadata = legacyMetadataSchema.parse(raw);
      if (metadata.sha256.toLowerCase() !== this.target.sha256.toLowerCase())
        throw new AnalysisProtocolError(
          `The attached IDA input SHA-256 does not match the selected target ${this.target.path}; open that target in IDA or use headless mode.`,
        );
      identity = JSON.stringify([
        metadata.path,
        metadata.sha256.toLowerCase(),
        metadata.base,
      ]);
      this.#metadata = raw;
    } else {
      if (this.#database === undefined || this.#workspace === undefined)
        throw new AnalysisProtocolError(
          "IDA headless session has no database binding.",
        );
      const raw = await this.connection.call("server_health", {
        database: this.#database,
      });
      const metadata = modernHealthSchema.parse(raw);
      if (
        !sameIdaHostPath(metadata.input_path, this.#workspace.inputPath) ||
        (await idaFileDigest(this.#workspace.inputPath)) !== this.target.sha256
      )
        throw new AnalysisProtocolError(
          "IDA headless input identity changed after target admission.",
        );
      if (metadata.auto_analysis_ready !== true)
        throw new AnalysisProtocolError(
          "IDA auto-analysis is incomplete or readiness is unknown; retry after analysis completes.",
        );
      identity = JSON.stringify([
        this.#database,
        metadata.input_path,
        metadata.idb_path,
        metadata.imagebase,
      ]);
      this.#metadata = raw;
    }
    if (
      this.#initialIdentity !== undefined &&
      identity !== this.#initialIdentity
    )
      throw new AnalysisProtocolError(
        "The attached IDA target or image base changed during the REA session; reopen the target.",
      );
    this.#initialIdentity = identity;
    return this.#metadata;
  }

  async closeWithOutcome(): Promise<Result<null, AnalysisError>> {
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
    try {
      if (this.#workspace !== undefined && this.#openAttempted) {
        if (this.#database === undefined) {
          const inventory = databaseListSchema.parse(
            await this.connection.call("idb_list", {}),
          );
          const workspace = this.#workspace;
          this.#database = inventory.sessions.find(
            (entry) =>
              entry.owned &&
              entry.backend === "worker" &&
              entry.session_id === workspace.sessionId &&
              sameIdaHostPath(entry.input_path, workspace.inputPath),
          )?.session_id;
          if (
            this.#database === undefined &&
            inventory.sessions.some((entry) =>
              sameIdaHostPath(entry.input_path, workspace.inputPath),
            )
          )
            throw new AnalysisProtocolError(
              "An unowned worker still uses the private workspace; it was retained.",
            );
        }
        if (this.#database !== undefined) {
          const closed = closeDatabaseSchema.parse(
            await this.connection.call("idb_close", {
              database: this.#database,
              save: false,
            }),
          );
          if (
            closed.session_id !== this.#database ||
            closed.saved === true ||
            closed.owned !== true ||
            closed.backend !== "worker"
          )
            throw new AnalysisProtocolError(
              "IDA database close did not confirm the requested owned, unsaved session release.",
            );
          const inventory = databaseListSchema.parse(
            await this.connection.call("idb_list", {}),
          );
          if (
            inventory.sessions.some(
              (entry) =>
                entry.session_id === this.#database ||
                sameIdaHostPath(
                  entry.input_path,
                  this.#workspace?.inputPath ?? "",
                ),
            )
          )
            throw new AnalysisProtocolError(
              "IDA worker remains registered after close.",
            );
        }
        if (!this.#openCompleted)
          throw new AnalysisProtocolError(
            "IDA database open did not return a completed response. Worker inventory cannot prove that the request has stopped; the private workspace was retained.",
          );
      }
      await this.connection.close();
      await this.#workspace?.remove();
      this.#closed = true;
      return ok(null);
    } catch (cause: unknown) {
      await this.connection.close().catch(() => undefined);
      return err(
        new IdaCleanupError(
          this.#workspace?.directory ?? "IDA MCP connection",
          cause,
        ),
      );
    }
  }

  async close(): Promise<void> {
    const result = await this.closeWithOutcome();
    if (!result.ok) throw result.error;
  }
}
