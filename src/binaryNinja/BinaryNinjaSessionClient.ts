import type { AppConfig } from "../config/types.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { createEvidence } from "../domain/evidence.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import type { BinaryNinjaConfiguration } from "./BinaryNinjaConfiguration.js";
import { parseBinaryNinjaInput } from "./BinaryNinjaInput.js";
import type {
  BinaryNinjaMcpConnection,
  BinaryNinjaToolReply,
} from "./BinaryNinjaMcpConnection.js";
import {
  BINARY_NINJA_MEMORY_READ_LIMIT,
  BinaryNinjaOperationRunner,
} from "./BinaryNinjaOperationRunner.js";
import { drainBinaryNinjaPages } from "./BinaryNinjaPaging.js";
import {
  BINARY_NINJA_LIMITATIONS,
  BINARY_NINJA_OPERATIONS,
  BINARY_NINJA_PROVIDER_IDENTITY,
  type BinaryNinjaOperation,
} from "./BinaryNinjaProviderCapabilities.js";
import {
  BINARY_NINJA_COLUMNS,
  binaryNinjaActiveViewSchema,
  binaryNinjaAnalysisStatusSchema,
  binaryNinjaMemoryReadSchema,
  binaryNinjaSetActiveSchema,
  parseBinaryNinjaDocument,
  parseBinaryNinjaTable,
  sameBinaryNinjaHostPath,
  type BinaryNinjaTableTool,
  type BinaryNinjaView,
} from "./BinaryNinjaProtocolValues.js";

/** Every built-in tool this adapter calls. Mutation, save, open and close tools are never called. */
export const BINARY_NINJA_REQUIRED_TOOLS = [
  "bn_open_item_list",
  "bn_binary_view_list",
  "bn_binary_view_get_active",
  "bn_binary_view_set_active",
  "bn_analysis_status",
  "bn_memory_read",
  "bn_function_list",
  "bn_function_search",
  "bn_function_info",
  "bn_function_decompile",
  "bn_function_disassembly",
  "bn_function_callers",
  "bn_function_callees",
  "bn_string_list",
  "bn_data_xrefs_to",
  "bn_symbol_list_at",
] as const;

const operationSet: ReadonlySet<string> = new Set(BINARY_NINJA_OPERATIONS);
const isBinaryNinjaOperation = (
  operation: string,
): operation is BinaryNinjaOperation => operationSet.has(operation);
const wasCancelled = (options: ExecutionOptions | undefined): boolean =>
  options?.signal?.aborted === true;

/** The attached file and the two views REA reads: its analysis view and its Raw bytes. */
interface BinaryNinjaBinding {
  readonly openItem: string;
  readonly path: string;
  readonly analysis: BinaryNinjaView;
  readonly raw: string;
}

/** Facts a failed request accumulated before it failed. */
interface FailureContext {
  readonly parameters: Readonly<Record<string, JsonValue>>;
  runner?: BinaryNinjaOperationRunner;
  before?: JsonValue;
  after?: JsonValue;
}

const RECOVERY =
  "Open the selected target in the Binary Ninja GUI, start Plugins > MCP > Start Server, and check REA_BINARY_NINJA_MCP_CONFIG; see docs/binary-ninja.md.";

/** Serial read-only session whose lifecycle authority excludes the attached GUI file. */
export class BinaryNinjaSessionClient implements AnalysisClient {
  #tail: Promise<void> = Promise.resolve();
  #startup: Promise<void> | undefined;
  #binding: BinaryNinjaBinding | undefined;
  #previousActiveView: string | null | undefined;
  #closed = false;
  #closing = false;
  #closePromise: Promise<Result<null, AnalysisError>> | undefined;
  #lifecycle: JsonValue[] = [];

  constructor(
    private readonly config: BinaryNinjaConfiguration,
    private readonly target: BinaryTarget,
    private readonly connection: BinaryNinjaMcpConnection,
    private readonly profile?: AnalysisProfileCommitment,
    private readonly regexOptions: Partial<
      Pick<AppConfig, "regexMatchingDeadline" | "regexWorkerHeapRequest">
    > = {},
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
  ): Promise<
    Result<ReturnType<typeof createAnalysisExecution>, AnalysisError>
  > {
    if (this.#closed || this.#closing)
      return err(
        new AnalysisProtocolError(
          "Binary Ninja session is closing or closed; reopen the target.",
        ),
      );
    if (wasCancelled(options))
      return err(
        new AnalysisCancelledError(operation, {
          cause: options?.signal?.reason,
        }),
      );
    if (operation !== "health" && !isBinaryNinjaOperation(operation))
      return err(
        new AnalysisCapabilityUnavailableError(
          BINARY_NINJA_PROVIDER_IDENTITY.id,
          operation,
          "This integration admits read-only analysis operations only.",
        ),
      );
    if (operation !== "health") {
      const parsed = parseBinaryNinjaInput(operation, parameters, this.target);
      if (!parsed.ok) return parsed;
      parameters = parsed.value;
    }
    const context: FailureContext = { parameters };
    try {
      await this.#start(operation, options);
      const before = await this.#select(options);
      context.before = before;
      if (wasCancelled(options))
        throw new AnalysisCancelledError(operation, {
          cause: options?.signal?.reason,
        });
      if (operation === "health") return ok(this.#health(before));
      if (!isBinaryNinjaOperation(operation))
        throw new AnalysisProtocolError(
          "Binary Ninja operation changed after validation.",
        );
      const runner = this.#runner(options);
      context.runner = runner;
      const result = await runner.run(operation, parameters);
      const after = await this.#verifyStillSelected(options);
      context.after = after;
      if (wasCancelled(options))
        throw new AnalysisCancelledError(operation, {
          cause: options?.signal?.reason,
        });
      return ok(
        createAnalysisExecution(result, BINARY_NINJA_PROVIDER_IDENTITY, {
          rawResult: {
            upstream: this.connection.serverInfo(),
            view_before: before,
            view_after: after,
            observations: jsonValueSchema.parse(runner.raw),
          },
          limitations: [...BINARY_NINJA_LIMITATIONS, ...runner.limitations],
          ...(runner.relationshipCoverage === undefined
            ? {}
            : { relationshipCoverage: runner.relationshipCoverage }),
          ...(runner.referencesTruncated === undefined
            ? {}
            : { referencesTruncated: runner.referencesTruncated }),
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
      return err(this.#failure(operation, cause, options, context));
    }
  }

  #runner(options: ExecutionOptions | undefined): BinaryNinjaOperationRunner {
    const binding = this.#requireBinding();
    return new BinaryNinjaOperationRunner(this.connection, {
      admittedDocument: this.target.path,
      architecture: binding.analysis.architecture,
      ...this.regexOptions,
      signal: options?.signal,
      selectorOrigin: options?.selectorOrigin,
    });
  }

  #health(view: JsonValue) {
    const binding = this.#requireBinding();
    return createAnalysisExecution(
      {
        ready: true,
        upstream: this.connection.serverInfo(),
        open_item: binding.openItem,
        path: binding.path,
        view,
        lifecycle: this.#lifecycle,
      },
      BINARY_NINJA_PROVIDER_IDENTITY,
      {
        limitations: BINARY_NINJA_LIMITATIONS,
        ...(this.profile === undefined
          ? {}
          : { analysisProfile: this.profile }),
      },
    );
  }

  #requireBinding(): BinaryNinjaBinding {
    if (this.#binding === undefined)
      throw new AnalysisProtocolError(
        "Binary Ninja session has no verified target binding.",
      );
    return this.#binding;
  }

  #failure(
    operation: string,
    cause: unknown,
    options: ExecutionOptions | undefined,
    { parameters, runner, before, after }: FailureContext,
  ): AnalysisError {
    let failure: AnalysisError;
    if (wasCancelled(options))
      failure = new AnalysisCancelledError(operation, {
        cause: options?.signal?.reason,
        ...(cause instanceof AnalysisError
          ? { diagnostics: cause.diagnostics }
          : {}),
      });
    else if (
      cause instanceof ProviderAdapterError &&
      cause.operation === "transport"
    )
      failure = new ProviderAdapterError(
        BINARY_NINJA_PROVIDER_IDENTITY.id,
        operation,
        { cause, diagnostics: cause.diagnostics },
      );
    else if (cause instanceof AnalysisError) failure = cause;
    else if (cause instanceof z.ZodError)
      failure = new AnalysisOutputError(
        operation,
        `Binary Ninja MCP returned malformed or unsupported producer data: ${cause.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ")}`,
        { cause },
      );
    else
      failure = new ProviderAdapterError(
        BINARY_NINJA_PROVIDER_IDENTITY.id,
        operation,
        {
          cause,
          diagnostics: {
            reason:
              cause instanceof Error
                ? cause.message
                : "Unknown upstream failure",
            recovery: RECOVERY,
          },
        },
      );
    // Replies completed after the pre-operation view check can become partial
    // Evidence. A rejected caller selector needs correction, not those replies.
    if (
      !(failure instanceof AnalysisInputError) &&
      runner !== undefined &&
      runner.raw.length > 0 &&
      before !== undefined
    ) {
      const observations = jsonValueSchema.parse(runner.raw);
      failure.retainPartialObservation(
        createEvidence(this.target, BINARY_NINJA_PROVIDER_IDENTITY, {
          predicateType: "analysis-observation",
          operation,
          parameters,
          result: {
            status: "partial",
            failed_operation: operation,
            observations,
            view_before: before,
            target_binding:
              after === undefined
                ? {
                    status: "not_verified",
                    reason: "The post-operation view check did not complete.",
                  }
                : { status: "verified" },
          },
          rawResult: {
            upstream: this.connection.serverInfo(),
            observations,
            view_before: before,
            ...(after === undefined ? {} : { view_after: after }),
          },
          confidence: "observed",
          authority: "external-service",
          limitations: [
            ...BINARY_NINJA_LIMITATIONS,
            ...runner.limitations,
            "The requested Binary Ninja operation failed after these completed replies; the partial Evidence does not establish a complete result.",
          ],
          locations: [
            { kind: "artifact-path", path: this.target.path },
            ...runner.locations,
          ],
          ...(this.profile === undefined
            ? {}
            : { analysisProfile: this.profile }),
        }),
      );
    }
    return failure;
  }

  async #start(operation: string, options?: ExecutionOptions): Promise<void> {
    this.#startup ??= this.#initialize(options?.signal);
    try {
      await this.#startup;
    } catch (cause: unknown) {
      // A failed binding is not cached: the analyst may open the file and retry.
      this.#startup = undefined;
      if (
        cause instanceof ProviderAdapterError &&
        cause.operation === "initialize"
      )
        throw new ProviderAdapterError(cause.providerId, operation, {
          cause,
          ...(cause.userMessage === undefined
            ? {}
            : { userMessage: cause.userMessage }),
          diagnostics: {
            ...cause.diagnostics,
            startup_operation: "initialize",
          },
        });
      throw cause;
    }
  }

  async #call(
    tool: string,
    args: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<BinaryNinjaToolReply> {
    if (signal?.aborted === true)
      throw new AnalysisCancelledError(tool, { cause: signal.reason });
    return this.connection.call(tool, args, signal);
  }

  async #table(
    tool: BinaryNinjaTableTool,
    signal?: AbortSignal,
  ): Promise<Record<string, string>[]> {
    const rows: Record<string, string>[] = [];
    await drainBinaryNinjaPages(
      tool,
      async (offset, limit) => {
        const reply = await this.#call(tool, { offset, limit }, signal);
        return parseBinaryNinjaDocument(reply.text ?? "", tool);
      },
      (document, page) => {
        const pageRows = parseBinaryNinjaTable(
          document.body,
          BINARY_NINJA_COLUMNS[tool],
          tool,
        );
        if (pageRows.length !== page.count)
          throw new AnalysisProtocolError(
            `Binary Ninja ${tool} returned an inconsistent page.`,
          );
        rows.push(...pageRows);
      },
    );
    return rows;
  }

  async #setActive(handle: string, signal?: AbortSignal) {
    const reply = await this.#call(
      "bn_binary_view_set_active",
      { binaryView: handle },
      signal,
    );
    const selected = binaryNinjaSetActiveSchema.parse(reply.structured);
    if (selected.binaryView.handle !== handle)
      throw new AnalysisProtocolError(
        "Binary Ninja activated a different BinaryView than requested.",
      );
    return selected;
  }

  /** Find the single open file whose path is the admitted target. */
  async #openItem(signal?: AbortSignal): Promise<Record<string, string>> {
    const items = (await this.#table("bn_open_item_list", signal)).filter(
      (row) =>
        row.kind === "file" &&
        (sameBinaryNinjaHostPath(row.path ?? "", this.target.path) ||
          (this.target.sourcePath !== undefined &&
            sameBinaryNinjaHostPath(row.path ?? "", this.target.sourcePath))),
    );
    if (items.length !== 1)
      throw new ProviderAdapterError(
        BINARY_NINJA_PROVIDER_IDENTITY.id,
        "initialize",
        {
          userMessage:
            items.length === 0
              ? `The selected target ${this.target.path} is not open in Binary Ninja. Open that file in the GUI and wait for analysis, then retry.`
              : `The selected target ${this.target.path} is open more than once in Binary Ninja. Close the duplicate tabs, then retry.`,
          diagnostics: {
            reason:
              items.length === 0 ? "target_not_open" : "target_open_ambiguous",
            matching_open_items: items.length,
            recovery: RECOVERY,
          },
        },
      );
    return items[0] as Record<string, string>;
  }

  /** Locate the already-open GUI file; selection verifies its Raw bytes before use. */
  async #initialize(signal?: AbortSignal): Promise<void> {
    const tools = new Set(await this.connection.connect(signal));
    const missing = BINARY_NINJA_REQUIRED_TOOLS.filter(
      (name) => !tools.has(name),
    );
    if (missing.length > 0) {
      const summary = `The Binary Ninja MCP server is missing built-in tools: ${missing.join(", ")}. REA requires the built-in GUI MCP server of Binary Ninja 6.0 or later; see docs/binary-ninja.md.`;
      throw new ProviderAdapterError(
        BINARY_NINJA_PROVIDER_IDENTITY.id,
        "initialize",
        {
          userMessage: summary,
          diagnostics: {
            reason: summary,
            missing_tools: [...missing],
            recovery: RECOVERY,
          },
        },
      );
    }
    const item = await this.#openItem(signal);
    const views = (await this.#table("bn_binary_view_list", signal)).filter(
      (row) => row.openItem === item.openItem,
    );
    const raw = views.find((row) => row.viewType === "Raw");
    const analysis = views.filter(
      (row) => row.recommended === "true" && row.viewType !== "Raw",
    );
    if (raw === undefined || analysis.length !== 1)
      throw new AnalysisProtocolError(
        "Binary Ninja did not report one recommended analysis view and a Raw view for the selected file.",
      );
    const active = binaryNinjaActiveViewSchema.parse(
      (await this.#call("bn_binary_view_get_active", {}, signal)).structured,
    );
    if (this.#previousActiveView === undefined)
      this.#previousActiveView = active.binaryView?.handle ?? null;
    const rawHandle = raw.binaryView ?? "";
    const analysisHandle = analysis[0]?.binaryView ?? "";
    const selected = await this.#setActive(analysisHandle, signal);
    this.#binding = {
      openItem: item.openItem ?? "",
      path: item.path ?? "",
      analysis: selected.binaryView,
      raw: rawHandle,
    };
    this.#lifecycle.push({
      open_item: item.openItem ?? "",
      raw_view: rawHandle,
    });
  }

  /** Rehash the live Raw bytes and restore the analysis view, including after failure. */
  async #verifyTargetBytes(
    rawHandle: string,
    analysisHandle: string,
    signal?: AbortSignal,
  ) {
    try {
      const rawView = (await this.#setActive(rawHandle, signal)).binaryView;
      const digest = await this.#rawDigest(rawView, signal);
      if (digest !== this.target.sha256.toLowerCase())
        throw new ProviderAdapterError(
          BINARY_NINJA_PROVIDER_IDENTITY.id,
          "verify_target",
          {
            userMessage: `The bytes Binary Ninja loaded for ${this.target.path} do not match the selected target. Reopen the current file in Binary Ninja, then retry.`,
            diagnostics: {
              reason: "target_digest_mismatch",
              expected_sha256: this.target.sha256.toLowerCase(),
              observed_sha256: digest,
              recovery: RECOVERY,
            },
          },
        );
      return await this.#setActive(analysisHandle, signal);
    } catch (cause: unknown) {
      // Restore even if cancellation arrives after the final Raw read.
      await this.#setActive(analysisHandle).catch(() => undefined);
      throw cause;
    }
  }

  /** Hash the Raw view in bounded reads; its bytes are the file Binary Ninja loaded. */
  async #rawDigest(
    view: BinaryNinjaView,
    signal?: AbortSignal,
  ): Promise<string> {
    const start = BigInt(view.start);
    const length = BigInt(view.end) - start;
    if (start !== 0n || length < 0n)
      throw new AnalysisProtocolError(
        "Binary Ninja reported a Raw view that does not start at file offset zero.",
      );
    if (length > BigInt(this.config.maxInputBytes))
      throw new AnalysisResourceConstraintError(
        "binary_ninja_identity",
        "file-size",
        `The attached input has ${length.toString()} bytes, above maxInputBytes ${String(this.config.maxInputBytes)}; REA cannot verify its identity within that bound.`,
        { max_input_bytes: this.config.maxInputBytes },
        {
          remediationAction:
            "Raise maxInputBytes in REA_BINARY_NINJA_MCP_CONFIG to admit larger targets.",
        },
      );
    const hash = createHash("sha256");
    for (let offset = 0n; offset < length;) {
      const chunk =
        length - offset > BigInt(BINARY_NINJA_MEMORY_READ_LIMIT)
          ? BINARY_NINJA_MEMORY_READ_LIMIT
          : Number(length - offset);
      const address = `0x${offset.toString(16)}`;
      const read = binaryNinjaMemoryReadSchema.parse(
        (await this.#call("bn_memory_read", { address, length: chunk }, signal))
          .structured,
      );
      if (read.address !== address || read.bytesRead !== chunk)
        throw new AnalysisProtocolError(
          `Binary Ninja read ${String(read.bytesRead)} of ${String(chunk)} Raw bytes at ${address}.`,
        );
      hash.update(Buffer.from(read.hex, "hex"));
      offset += BigInt(chunk);
    }
    return hash.digest("hex");
  }

  /** Re-select the bound analysis view and require settled analysis before a request. */
  async #select(options?: ExecutionOptions): Promise<JsonValue> {
    const binding = this.#requireBinding();
    const selected = await this.#verifyTargetBytes(
      binding.raw,
      binding.analysis.handle,
      options?.signal,
    );
    this.#requireSameView(selected.binaryView);
    const status = binaryNinjaAnalysisStatusSchema.parse(
      (await this.#call("bn_analysis_status", {}, options?.signal)).structured,
    );
    if (status.analysis.state !== "IdleState")
      throw new AnalysisProtocolError(
        `Binary Ninja analysis is still running (${status.analysis.state}); retry after analysis completes.`,
      );
    return jsonValueSchema.parse(selected.binaryView);
  }

  /** Another MCP client can switch the shared active view; such a request is not attributable. */
  async #verifyStillSelected(options?: ExecutionOptions): Promise<JsonValue> {
    const active = binaryNinjaActiveViewSchema.parse(
      (await this.#call("bn_binary_view_get_active", {}, options?.signal))
        .structured,
    );
    if (active.binaryView === null)
      throw new AnalysisProtocolError(
        "The Binary Ninja active view was cleared during the request; retry.",
      );
    this.#requireSameView(active.binaryView);
    const binding = this.#requireBinding();
    const selected = await this.#verifyTargetBytes(
      binding.raw,
      binding.analysis.handle,
      options?.signal,
    );
    this.#requireSameView(selected.binaryView);
    return jsonValueSchema.parse(selected.binaryView);
  }

  #requireSameView(view: BinaryNinjaView): void {
    const bound = this.#requireBinding().analysis;
    if (
      view.handle !== bound.handle ||
      view.openItem !== bound.openItem ||
      view.viewType !== bound.viewType ||
      view.architecture !== bound.architecture ||
      view.start !== bound.start ||
      view.end !== bound.end ||
      view.entryPoint !== bound.entryPoint
    )
      throw new AnalysisProtocolError(
        "The Binary Ninja view bound to this target changed during the REA session; reopen the target.",
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
    await this.#startup?.catch(() => undefined);
    if (this.#closed) return ok(null);
    // Restore another client's selection on a best-effort basis; REA owns only its connection.
    const previous = this.#previousActiveView;
    if (
      previous !== undefined &&
      previous !== null &&
      previous !== this.#binding?.analysis.handle
    )
      await this.#setActive(previous).catch((cause: unknown) => {
        this.#lifecycle.push({
          restore_active_view: previous,
          failed: cause instanceof Error ? cause.message : "unknown",
        });
      });
    try {
      await this.connection.close();
      this.#closed = true;
      return ok(null);
    } catch (cause: unknown) {
      return err(
        new ProviderCleanupError(
          BINARY_NINJA_PROVIDER_IDENTITY.id,
          ["Binary Ninja MCP connection"],
          {
            reason:
              cause instanceof Error
                ? cause.message
                : "The Binary Ninja MCP connection did not close.",
          },
          { cause },
        ),
      );
    }
  }
}
