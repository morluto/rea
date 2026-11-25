import { copyFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { AnalysisCleanupLease } from "../resources/index.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import type { HarmonyAbcAnalysisPort } from "../ports/harmony/HarmonyAbcAnalysisPort.js";
import {
  createAnalysisExecution,
  type ExecutionOptions,
} from "../ports/AnalysisProvider.js";
import { err, ok, type Result } from "../domain/result.js";
import type { HarmonyAbcRequest } from "../domain/harmony/harmonyAbcAnalysis.js";
import {
  harmonyAbcResultSchemas,
  DEFAULT_HARMONY_ABC_ANALYSIS_TIMEOUT_MS,
} from "../domain/harmony/harmonyAbcAnalysis.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  OwnerCancellation,
  carriedReason,
  cancelledBy,
} from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  analysisErrorWithCleanupDependencies,
  analysisErrorWithCleanupFailure,
} from "../domain/analysisErrorCleanup.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { hashStableFile } from "../filesystem/StableFileHash.js";
import type { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { RegularFileChangedError } from "../filesystem/RegularFile.js";
import type { OwnedMcpLauncher } from "../process/OwnedMcpStdioTransport.js";
import { XpandaBridge } from "./XpandaBridge.js";
import {
  resolveXpandaConfiguration,
  type XpandaConfigurationFailure,
} from "./XpandaConfiguration.js";
import {
  hashXpandaEngine,
  XpandaEngineScanError,
} from "./XpandaEngineIdentity.js";
import {
  parseXpandaDecompile,
  parseXpandaDisassembly,
  xpandaCallGraphSchema,
  xpandaClassListSchema,
  xpandaClassMetadataSchema,
  xpandaCodeSearchSchema,
  xpandaExportSchema,
  xpandaHapAbcSchema,
  xpandaHapResourcesSchema,
  isHapLoad,
  xpandaSessionSchema,
  xpandaStringMatchesSchema,
  xpandaSymbolSearchSchema,
  xpandaXrefsSchema,
  type XpandaSession,
} from "./XpandaProtocol.js";
import { captureXpandaFailure } from "./XpandaFailures.js";
import {
  XPANDA_BYTECODE_VERSION_SUPPORT,
  XPANDA_CHECKOUT_REMEDIATION,
  XPANDA_LIMITATIONS,
  XPANDA_LIMITS,
  XPANDA_PROVIDER_ID,
  XPANDA_UNSUPPORTED_HOST_REMEDIATION,
  XPANDA_VERIFIED_VERSION,
} from "./XpandaRelease.js";
import { errorMessage } from "../kernel/errorMessage.js";

type Outcome = Awaited<ReturnType<HarmonyAbcAnalysisPort["execute"]>>;

const IDLE_RETIRE_MS = 60_000;

/** How long a caller waits behind the provider's serialized request tail. */
const waitForTurn = (
  predecessor: Promise<void>,
  operation: string,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const abort = () =>
      reject(cancelledBy(operation, carriedReason(signal?.reason)));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
    void predecessor.then(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    });
  });

interface RetainedBridge {
  readonly key: string;
  readonly engineSha256: string;
  readonly version: string;
  readonly bridge: XpandaBridge;
}

interface StagedInput {
  readonly lease: AnalysisCleanupLease;
  readonly stagedPath: string;
  readonly sha256: string;
  readonly size: number;
  /** Hash descriptors that could not close; joined before the root lease. */
  readonly failedHandles: Map<OwnedFileHandle, string>;
}

interface EngineFacts {
  readonly root: string;
  readonly sha256: string;
  readonly version: string;
}

/** Project a tagged configuration failure onto the operation boundary. */
const configurationUnavailable = (
  operation: string,
  failure: XpandaConfigurationFailure,
): AnalysisCapabilityUnavailableError =>
  new AnalysisCapabilityUnavailableError(
    XPANDA_PROVIDER_ID,
    operation,
    failure.reason,
    {
      userMessage: failure.reason,
      remediationAction: failure.remediation,
    },
  );

/** Bind a staging cleanup failure onto a finished outcome without losing facts. */
const finishStagedInput = async (
  staged: StagedInput | undefined,
  outcome: Outcome,
  operation: string,
): Promise<Outcome> => {
  if (staged === undefined) return outcome;
  const closeCauses: unknown[] = [];
  for (const [owner, path] of staged.failedHandles) {
    try {
      await owner.close();
      staged.failedHandles.delete(owner);
    } catch (cause: unknown) {
      closeCauses.push(cause);
    }
  }
  try {
    await staged.lease.release();
    if (closeCauses.length === 0) return outcome;
  } catch (cause: unknown) {
    closeCauses.push(cause);
  }
  const cleanup = new ProviderCleanupError(
    XPANDA_PROVIDER_ID,
    [staged.stagedPath],
    {
      reason: closeCauses.map((failure) => errorMessage(failure)).join("; "),
    },
    { operation, cause: new AggregateError(closeCauses) },
  );
  staged.lease.bindCleanupError(cleanup);
  return err(
    outcome.ok
      ? cleanup
      : analysisErrorWithCleanupDependencies(outcome.error, cleanup, operation),
  );
};

/** One serialized, retained xpanda bridge per REA instance, retired on idle or shutdown. */
export class XpandaProvider implements HarmonyAbcAnalysisPort {
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #closing: Promise<void> | undefined;
  #retained: RetainedBridge | undefined;
  /** Bridge whose owned stop could not be proven; retried before the next run. */
  #pendingBridge: XpandaBridge | undefined;
  #pendingBridgeResources: readonly string[] = [];
  #idle: NodeJS.Timeout | undefined;
  readonly #shutdown = new AbortController();
  readonly #idleRetireMs: number;
  readonly #platform: NodeJS.Platform;
  constructor(
    readonly environment: Readonly<
      Record<string, string | undefined>
    > = process.env,
    readonly launcher?: OwnedMcpLauncher,
    options: {
      readonly idleRetireMs?: number;
      readonly platform?: NodeJS.Platform;
    } = {},
  ) {
    this.#idleRetireMs = options.idleRetireMs ?? IDLE_RETIRE_MS;
    this.#platform = options.platform ?? HOST_PLATFORM.platform;
  }

  /** Execute one explicit HarmonyOS Ark bytecode operation. */
  async execute(
    request: HarmonyAbcRequest,
    options?: ExecutionOptions,
  ): Promise<Outcome> {
    if (this.#closed)
      return err(cancelledBy(request.operation, OwnerCancellation.ownerClosed));
    const predecessor = this.#tail;
    let release = () => {};
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Cancel the caller promptly without letting a later request bypass its predecessor.
    try {
      await waitForTurn(predecessor, request.operation, options?.signal);
    } catch (cause: unknown) {
      void predecessor.then(release);
      return err(
        cause instanceof AnalysisError
          ? cause
          : cancelledBy(request.operation, carriedReason(cause)),
      );
    }
    try {
      if (this.#closed)
        return err(
          cancelledBy(request.operation, OwnerCancellation.ownerClosed),
        );
      const blocked = await this.#retryPendingBridge();
      if (blocked !== undefined) return err(blocked);
      return await this.#execute(request, options);
    } finally {
      release();
    }
  }

  /** Cancel queued work, retire the bridge and join its owned cleanup. */
  close(): Promise<void> {
    this.#closed = true;
    this.#shutdown.abort(OwnerCancellation.ownerClosed);
    clearTimeout(this.#idle);
    return (this.#closing ??= this.#tail
      .then(async () => {
        await this.#retryPendingBridge();
        const retired = await this.#retire();
        if (!retired.ok) throw retired.error;
      })
      .catch((cause: unknown) => {
        this.#closing = undefined;
        throw cause;
      }));
  }

  /** Retry a bridge whose previous stop was unproven; execution stays blocked. */
  async #retryPendingBridge(): Promise<AnalysisError | undefined> {
    if (this.#pendingBridge === undefined) return undefined;
    const bridge = this.#pendingBridge;
    try {
      await bridge.close();
      this.#pendingBridge = undefined;
      this.#pendingBridgeResources = [];
      return undefined;
    } catch (cause: unknown) {
      return new ProviderCleanupError(
        XPANDA_PROVIDER_ID,
        this.#pendingBridgeResources,
        { reason: errorMessage(cause) },
        { operation: "close_xpanda", cause },
      );
    }
  }

  /** Stop and prove the retained bridge; retain it when its stop is unproven. */
  async #retire(): Promise<Result<void, AnalysisError>> {
    clearTimeout(this.#idle);
    this.#idle = undefined;
    const bridge = this.#retained?.bridge;
    this.#retained = undefined;
    if (bridge === undefined) return ok(undefined);
    try {
      await bridge.close();
      return ok(undefined);
    } catch (cause: unknown) {
      this.#pendingBridge = bridge;
      this.#pendingBridgeResources = [bridge.transport.runId];
      return err(
        new ProviderCleanupError(
          XPANDA_PROVIDER_ID,
          this.#pendingBridgeResources,
          { reason: errorMessage(cause) },
          { operation: "close_xpanda", cause },
        ),
      );
    }
  }

  #scheduleIdle(): void {
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => {
      this.#tail = this.#tail.then(async () => {
        await this.#retryPendingBridge();
        await this.#retire();
      });
    }, this.#idleRetireMs);
    this.#idle.unref();
  }

  async #execute(
    request: HarmonyAbcRequest,
    options?: ExecutionOptions,
  ): Promise<Outcome> {
    if (this.#shutdown.signal.aborted)
      return err(cancelledBy(request.operation, this.#shutdown.signal));
    const timeoutMs =
      request.input.analysis_timeout_ms ??
      DEFAULT_HARMONY_ABC_ANALYSIS_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([
      timeout,
      this.#shutdown.signal,
      ...(options?.signal === undefined ? [] : [options.signal]),
    ]);
    let staged: StagedInput | undefined;
    // Producer coherence errors keep the bridge; transport and deadline
    // failures poison a serialized single-threaded producer and retire it.
    let bridgeFatal = true;
    let outcome: Outcome;
    try {
      if (signal.aborted) throw cancelledBy(request.operation, signal);
      if (this.#platform !== "linux" && this.#platform !== "darwin")
        throw new AnalysisCapabilityUnavailableError(
          XPANDA_PROVIDER_ID,
          request.operation,
          `The xpanda provider requires Linux or macOS; ${this.#platform} is unsupported.`,
          { remediationAction: XPANDA_UNSUPPORTED_HOST_REMEDIATION },
        );
      const configuration = await resolveXpandaConfiguration(this.environment, {
        signal,
        platform: this.#platform,
      });
      if (!configuration.ok)
        throw configurationUnavailable(request.operation, configuration.error);
      const engine = await hashXpandaEngine(configuration.value.root).catch(
        (cause: unknown) => {
          if (cause instanceof XpandaEngineScanError)
            throw new AnalysisCapabilityUnavailableError(
              XPANDA_PROVIDER_ID,
              request.operation,
              cause.message,
              { remediationAction: XPANDA_CHECKOUT_REMEDIATION },
            );
          throw cause;
        },
      );
      const key = JSON.stringify({
        root: configuration.value.root,
        serverEntry: configuration.value.serverEntry,
        engine: engine.sha256,
        node: process.version,
      });
      if (this.#retained !== undefined && this.#retained.key !== key) {
        const retired = await this.#retire();
        if (!retired.ok) return err(retired.error);
      }
      // Stage before any engine acquisition so invalid inputs never start one.
      staged = await this.#stage(request, signal);
      await this.#admitOperation(request);
      if (this.#retained === undefined) {
        const bridge = new XpandaBridge(
          {
            command: process.execPath,
            arguments: ["--import", "tsx", configuration.value.serverEntry],
            expectedCommand: null,
            cwd: configuration.value.root,
            hostEnvironment: this.environment,
            signal: this.#shutdown.signal,
          },
          this.launcher,
        );
        this.#retained = {
          key,
          engineSha256: engine.sha256,
          version: configuration.value.version,
          bridge,
        };
      }
      const retained = this.#retained;
      const bridge = retained.bridge;
      const callContext = { signal, timeoutMs };
      await bridge.ensureConnected({
        operation: request.operation,
        signal,
        timeoutMs,
      });
      const load = await bridge.callJson(
        request.operation,
        "abc_load",
        xpandaSessionSchema,
        { path: staged.stagedPath },
        callContext,
      );
      const result = await this.#dispatch(
        request,
        bridge,
        load,
        {
          root: configuration.value.root,
          sha256: retained.engineSha256,
          version: retained.version,
        },
        callContext,
      );
      const parsed = harmonyAbcResultSchemas[request.operation].parse(result);
      // Best-effort producer session release; the producer's LRU bounds any
      // leak, and a failed close stays visible in the retained raw facts.
      let sessionCloseFailed = false;
      try {
        await bridge.call(
          request.operation,
          "abc_close",
          { fileId: load.fileId },
          callContext,
        );
      } catch {
        sessionCloseFailed = true;
      }
      const execution = createAnalysisExecution(
        parsed,
        { id: XPANDA_PROVIDER_ID, name: "xpanda", version: retained.version },
        {
          rawResult: {
            server: bridge.serverIdentity(),
            engine_sha256: retained.engineSha256,
            engine_files: engine.files,
            engine_bytes: engine.bytes,
            staged_input: { bytes: staged.size, sha256: staged.sha256 },
            load,
            calls: bridge.observedCalls(),
            session_close_failed: sessionCloseFailed,
          },
          subject: {
            path: request.input.path,
            sha256: staged.sha256,
            format: request.operation.startsWith("inspect_harmony_hap_")
              ? ("hap" as const)
              : ("abc" as const),
          },
          limitations: [
            ...XPANDA_LIMITATIONS,
            ...(retained.version === XPANDA_VERIFIED_VERSION
              ? []
              : [
                  `The configured xpanda checkout reports ${retained.version}; REA verified ${XPANDA_VERIFIED_VERSION}, so this release's producer surface is unverified.`,
                ]),
          ],
          locations:
            request.operation === "decompile_harmony_abc"
              ? [
                  {
                    kind: "artifact-path",
                    path: request.input.output_directory,
                  },
                ]
              : [],
        },
      );
      bridgeFatal = false;
      outcome = ok(execution);
    } catch (cause: unknown) {
      if (cause instanceof AnalysisInputError) bridgeFatal = false;
      const failure = captureXpandaFailure({
        cause,
        request,
        timeout,
        timeoutMs,
        signal: options?.signal,
        bridge: this.#retained?.bridge,
      });
      if (bridgeFatal) {
        const retired = await this.#retire();
        if (!retired.ok) {
          outcome = err(
            analysisErrorWithCleanupDependencies(
              failure(),
              retired.error,
              request.operation,
            ),
          );
        } else outcome = err(failure());
      } else outcome = err(failure());
    }
    if (this.#retained !== undefined) this.#scheduleIdle();
    return finishStagedInput(staged, outcome, request.operation);
  }

  /** Operation-specific admission that must precede any producer call. */
  async #admitOperation(request: HarmonyAbcRequest): Promise<void> {
    if (request.operation !== "decompile_harmony_abc") return;
    // The documented contract is an absent directory: the producer creates it
    // recursively and overwrites per-class files inside it.
    try {
      await stat(request.input.output_directory);
      throw new AnalysisInputError(request.operation, undefined, [
        {
          path: ["output_directory"],
          reason: "invalid_value",
          message: `The output directory already exists: ${request.input.output_directory}. Select an absent directory; the producer creates it and may overwrite its files.`,
        },
      ]);
    } catch (cause: unknown) {
      if (cause instanceof AnalysisInputError) throw cause;
      if (
        !(cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      )
        throw new AnalysisInputError(request.operation, { cause }, [
          {
            path: ["output_directory"],
            reason: "invalid_value",
            message: `The output directory path is not usable: ${request.input.output_directory}: ${errorMessage(cause)}`,
          },
        ]);
    }
  }

  /** Copy the selected bytes once into a private root and bind their identity. */
  async #stage(
    request: HarmonyAbcRequest,
    signal: AbortSignal,
  ): Promise<StagedInput> {
    const root = await PrivateRuntimeRoot.create({ prefix: "rea-xpanda-" });
    const lease = new AnalysisCleanupLease(() => root.close());
    const failedHandles = new Map<OwnedFileHandle, string>();
    const retainFailedClose = (path: string) => (owner: OwnedFileHandle) => {
      // A hash descriptor that cannot close joins this input's staged cleanup.
      failedHandles.set(owner, path);
    };
    try {
      const stagedPath = join(root.path, "input.abc");
      let size: number;
      try {
        size = (await stat(request.input.path)).size;
      } catch (cause: unknown) {
        if (
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "ENOENT"
        )
          throw new AnalysisInputError(request.operation, undefined, [
            {
              path: ["path"],
              reason: "invalid_value",
              message: `The selected path does not exist: ${request.input.path}`,
            },
          ]);
        throw cause;
      }
      if (!Number.isSafeInteger(size) || size < 0)
        throw new AnalysisInputError(request.operation, undefined, [
          {
            path: ["path"],
            reason: "invalid_value",
            message: `The selected path is not a regular file: ${request.input.path}`,
          },
        ]);
      if (size > XPANDA_LIMITS.inputBytes)
        throw new AnalysisInputError(
          request.operation,
          {
            userMessage: `The selected HarmonyOS Ark bytecode file is ${String(size)} bytes; this integration admits at most ${String(XPANDA_LIMITS.inputBytes)} bytes.`,
          },
          [
            {
              path: ["path"],
              reason: "invalid_value",
              message: `Input exceeds the ${String(XPANDA_LIMITS.inputBytes)}-byte admission bound`,
            },
          ],
        );
      await copyFile(request.input.path, stagedPath);
      const inputChanged = (path: string) =>
        new AnalysisInputError(
          request.operation,
          {
            userMessage: `The selected file changed while REA staged it at ${path}; retry against a stable file.`,
          },
          [
            {
              path: ["path"],
              reason: "invalid_value",
              message: "Input changed during staging",
            },
          ],
        );
      let sourceSha256: string;
      try {
        sourceSha256 = (
          await hashStableFile(request.input.path, {
            signal,
            retainFailedClose: retainFailedClose(request.input.path),
          })
        ).sha256;
      } catch (cause: unknown) {
        if (cause instanceof RegularFileChangedError)
          throw inputChanged(request.input.path);
        throw cause;
      }
      let stagedSha256: string;
      try {
        stagedSha256 = (
          await hashStableFile(stagedPath, {
            signal,
            retainFailedClose: retainFailedClose(stagedPath),
          })
        ).sha256;
      } catch (cause: unknown) {
        if (cause instanceof RegularFileChangedError)
          throw inputChanged(stagedPath);
        throw cause;
      }
      if (stagedSha256 !== sourceSha256) throw inputChanged(request.input.path);
      return {
        lease,
        stagedPath,
        sha256: stagedSha256,
        size,
        failedHandles,
      };
    } catch (cause: unknown) {
      // Join failed hash descriptors before releasing the fresh root; a root
      // whose removal still fails is reported through the lease error.
      for (const [owner] of failedHandles) {
        await owner.close().catch(() => undefined);
      }
      await lease.release().catch(() => undefined);
      throw cause;
    }
  }

  /** Producer call sequence for one admitted operation. */
  async #dispatch(
    request: HarmonyAbcRequest,
    bridge: XpandaBridge,
    load: XpandaSession,
    engine: EngineFacts,
    context: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ): Promise<unknown> {
    const engineFacts = {
      name: XPANDA_PROVIDER_ID,
      version: engine.version,
      root_path: engine.root,
      engine_sha256: engine.sha256,
      source_revision: null,
      bytecode_version_support: XPANDA_BYTECODE_VERSION_SUPPORT,
    };
    const budget =
      request.input.analysis_timeout_ms ??
      DEFAULT_HARMONY_ABC_ANALYSIS_TIMEOUT_MS;
    const hapOperation = request.operation.startsWith("inspect_harmony_hap_");
    if (hapOperation !== isHapLoad(load)) {
      throw new AnalysisInputError(request.operation, undefined, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: hapOperation
            ? "The selected file is not a HarmonyOS application package (.hap)."
            : "The selected file is a HarmonyOS application package (.hap); select an .abc entry with inspect_harmony_hap_abc first.",
        },
      ]);
    }
    if (!hapOperation && isHapLoad(load)) throw new Error("unreachable");
    await bridge.requireTool(request.operation, context);
    switch (request.operation) {
      case "inspect_harmony_abc": {
        if (isHapLoad(load)) throw new Error("unreachable");
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          input_size: load.fileSizeBytes,
          bytecode_version: load.bytecodeVersion,
          checksum: load.checksum,
          class_count: load.classCount,
          foreign_class_count: load.foreignClassCount,
          lnp_count: load.lnpCount,
          class_name_preview: load.classesPreview,
          preview_truncated: load.previewTruncated,
          coverage: "header",
        };
      }
      case "list_harmony_abc_classes": {
        const listing = await bridge.callJson(
          request.operation,
          "abc_list_classes",
          xpandaClassListSchema,
          {
            fileId: load.fileId,
            ...(request.input.filter === undefined
              ? {}
              : { filter: request.input.filter }),
            offset: request.input.offset,
            limit: request.input.limit,
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          total_classes: listing.total,
          filtered_classes: listing.filtered,
          offset: listing.offset,
          returned: listing.returned,
          truncated: listing.truncated,
          classes: listing.classes,
          coverage: "class_inventory",
        };
      }
      case "decompile_harmony_abc_class": {
        const decompiled = parseXpandaDecompile(
          request.operation,
          await bridge.call(
            request.operation,
            "abc_decompile_class",
            {
              fileId: load.fileId,
              className: request.input.class_name,
              ...(request.input.simplify ? {} : { simplify: false }),
            },
            context,
          ),
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          class_name:
            decompiled.className.length > 0
              ? decompiled.className
              : request.input.class_name,
          simplified: decompiled.simplified,
          degraded: decompiled.degraded,
          empty_result: decompiled.emptyResult,
          truncated: decompiled.truncated,
          characters: decompiled.characters,
          content: decompiled.content,
          coverage: "single_class",
        };
      }
      case "decompile_harmony_abc": {
        const exported = await bridge.callJson(
          request.operation,
          "abc_export",
          xpandaExportSchema,
          {
            fileId: load.fileId,
            outDir: request.input.output_directory,
            ...(request.input.simplify ? {} : { simplify: false }),
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          output_directory: exported.outDir,
          written: exported.written,
          skipped: exported.skipped,
          failed: exported.failed,
          degraded_classes: exported.degradedClasses,
          files: exported.files,
          files_truncated: exported.filesTruncated,
          coverage:
            exported.failed > 0 || exported.skipped > 0
              ? "partial"
              : "complete",
        };
      }
      case "disassemble_harmony_abc_method": {
        const disassembled = parseXpandaDisassembly(
          request.operation,
          await bridge.call(
            request.operation,
            "abc_disassemble_method",
            {
              fileId: load.fileId,
              className: request.input.class_name,
              ...(request.input.method_name === undefined
                ? {}
                : { methodName: request.input.method_name }),
              maxInstructions: request.input.max_instructions,
            },
            context,
          ),
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          class_name: request.input.class_name,
          method_name: disassembled.methodName,
          virtual_registers: disassembled.virtualRegisters,
          arguments: disassembled.arguments,
          blocks: disassembled.blocks,
          truncated: disassembled.truncated,
          text: disassembled.text,
          coverage: "single_method",
        };
      }
      case "search_harmony_abc_strings": {
        const matches = await bridge.callJson(
          request.operation,
          "abc_search_strings",
          xpandaStringMatchesSchema,
          {
            fileId: load.fileId,
            pattern: request.input.pattern,
            regex: request.input.regex,
            offset: request.input.offset,
            limit: request.input.limit,
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          pool_size: matches.poolSize,
          matched: matches.matched,
          offset: matches.offset,
          returned: matches.returned,
          truncated: matches.truncated,
          strings: matches.strings,
          coverage: "string_pool",
        };
      }
      case "inspect_harmony_abc_class": {
        const metadata = await bridge.callJson(
          request.operation,
          "abc_get_class",
          xpandaClassMetadataSchema,
          {
            fileId: load.fileId,
            className: request.input.class_name,
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          class_name: metadata.name,
          raw_name: metadata.rawName,
          super_class: metadata.superClass,
          external: metadata.external,
          access_flags: metadata.accessFlags,
          fields: metadata.fields.map(({ name, type, external }) => ({
            name,
            field_type: type,
            external,
          })),
          methods: metadata.methods.map(
            ({
              name,
              accessFlags,
              external,
              hasCode,
              hasTryCatch,
              shorty,
            }) => ({
              name,
              access_flags: accessFlags,
              external,
              has_code: hasCode,
              has_try_catch: hasTryCatch,
              shorty,
            }),
          ),
          imports: metadata.imports.map(
            ({ localName, importName, path, kind }) => ({
              local_name: localName,
              import_name: importName,
              path,
              kind,
            }),
          ),
          exports: metadata.exports.map(
            ({ localName, exportName, path, kind }) => ({
              local_name: localName,
              export_name: exportName,
              path,
              kind,
            }),
          ),
          coverage: "class_metadata",
        };
      }
      case "decompile_harmony_abc_method": {
        const decompiled = parseXpandaDecompile(
          request.operation,
          await bridge.call(
            request.operation,
            "abc_decompile_method",
            {
              fileId: load.fileId,
              className: request.input.class_name,
              methodName: request.input.method_name,
              ...(request.input.simplify ? {} : { simplify: false }),
            },
            context,
          ),
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          class_name:
            decompiled.className.length > 0
              ? decompiled.className
              : request.input.class_name,
          method_name: decompiled.methodName ?? request.input.method_name,
          simplified: decompiled.simplified,
          degraded: decompiled.degraded,
          empty_result: decompiled.emptyResult,
          truncated: decompiled.truncated,
          characters: decompiled.characters,
          content: decompiled.content,
          coverage: "method_source",
        };
      }
      case "search_harmony_abc_symbols": {
        const found = await bridge.callJson(
          request.operation,
          "abc_search_symbols",
          xpandaSymbolSearchSchema,
          {
            fileId: load.fileId,
            query: request.input.query,
            kind: request.input.kind,
            regex: request.input.regex,
            caseSensitive: request.input.case_sensitive,
            ...(request.input.class_filter === undefined
              ? {}
              : { classFilter: request.input.class_filter }),
            includeExternal: request.input.include_external,
            offset: request.input.offset,
            limit: request.input.limit,
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          total: found.total,
          offset: found.offset,
          limit: found.limit,
          returned: found.returned,
          truncated: found.truncated,
          matches: found.matches.map((match) => ({
            kind: match.kind,
            raw_name: match.rawName,
            name: match.name,
            ...(match.ownerClass === undefined
              ? {}
              : { owner_class: match.ownerClass }),
            ...(match.ownerClassName === undefined
              ? {}
              : { owner_class_name: match.ownerClassName }),
            ...(match.type === undefined ? {} : { field_type: match.type }),
            ...(match.methodCount === undefined
              ? {}
              : { method_count: match.methodCount }),
            ...(match.fieldCount === undefined
              ? {}
              : { field_count: match.fieldCount }),
            ...(match.external === undefined
              ? {}
              : { external: match.external }),
            ...(match.hasCode === undefined ? {} : { has_code: match.hasCode }),
          })),
          coverage: "symbol_index",
        };
      }
      case "search_harmony_abc_code": {
        const found = await bridge.callJson(
          request.operation,
          "abc_search_code",
          xpandaCodeSearchSchema,
          {
            fileId: load.fileId,
            pattern: request.input.pattern,
            regex: request.input.regex,
            caseSensitive: request.input.case_sensitive,
            ...(request.input.class_filter === undefined
              ? {}
              : { classFilter: request.input.class_filter }),
            simplify: request.input.simplify,
            maxClasses: request.input.max_classes,
            contextLines: request.input.context_lines,
            offset: request.input.offset,
            limit: request.input.limit,
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          pattern: found.pattern,
          simplified: found.simplified,
          scanned_classes: found.scannedClasses,
          skipped_classes: found.skippedClasses,
          failed_classes: found.failedClasses,
          failed_class_count: found.failedClassCount,
          candidate_classes: found.candidateClasses,
          truncated_classes: found.truncatedClasses,
          total: found.total,
          offset: found.offset,
          limit: found.limit,
          returned: found.returned,
          truncated: found.truncated,
          matches: found.matches.map(
            ({ className, line, text, method, methodKind, context }) => ({
              class_name: className,
              line,
              text,
              ...(method === undefined ? {} : { method }),
              ...(methodKind === undefined ? {} : { method_kind: methodKind }),
              ...(context === undefined
                ? {}
                : { context: context.map((entry) => ({ ...entry })) }),
            }),
          ),
          coverage: "decompiled_source",
        };
      }
      case "trace_harmony_abc_references": {
        const found = await bridge.callJson(
          request.operation,
          "abc_xrefs",
          xpandaXrefsSchema,
          {
            fileId: load.fileId,
            targetType: request.input.target_type,
            target: request.input.target,
            ...(request.input.owner_class === undefined
              ? {}
              : { ownerClass: request.input.owner_class }),
            source: request.input.source,
            maxClasses: request.input.max_classes,
            offset: request.input.offset,
            limit: request.input.limit,
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          target_type: found.targetType,
          target: found.target,
          target_owner: found.targetOwner,
          total: found.total,
          offset: found.offset,
          limit: found.limit,
          returned: found.returned,
          truncated: found.truncated,
          source_scanned_classes: found.sourceScannedClasses,
          source_truncated_classes: found.sourceTruncatedClasses,
          xref_count: found.xrefCount,
          disassembly_failures: found.disassemblyFailures,
          matches: found.matches.map((match) => ({
            from_class: match.fromClass,
            from_class_raw: match.fromClassRaw,
            from_method: match.fromMethod,
            pc: match.pc,
            line: match.line ?? null,
            opcode: match.opcode,
            kind: match.kind,
            target_type: match.targetType,
            target_name: match.targetName,
            target_class: match.targetClass,
            target_class_raw: match.targetClassRaw,
            origin: match.origin,
          })),
          coverage: "bytecode_references",
        };
      }
      case "build_harmony_abc_call_graph": {
        const graph = await bridge.callJson(
          request.operation,
          "abc_call_graph",
          xpandaCallGraphSchema,
          {
            fileId: load.fileId,
            className: request.input.class_name,
            methodName: request.input.method_name,
            direction: request.input.direction,
            depth: request.input.depth,
            maxNodes: request.input.max_nodes,
            maxClasses: request.input.max_classes,
            simplify: request.input.simplify,
            format: request.input.format,
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          root_class: graph.root.class,
          root_method: graph.root.method,
          direction: graph.direction,
          depth: graph.depth,
          node_count: graph.nodeCount,
          edge_count: graph.edgeCount,
          truncated: graph.truncated,
          disassembly_failures: graph.disassemblyFailures,
          source_truncated_classes: graph.sourceTruncatedClasses,
          nodes: graph.nodes.map((node) => ({
            id: node.id,
            class_name: node.className,
            class_raw: node.classRaw,
            method: node.method,
            depth: node.depth,
            via: node.via,
          })),
          edges: graph.edges,
          ...(graph.mermaid === undefined ? {} : { mermaid: graph.mermaid }),
          coverage: "call_graph",
        };
      }
      case "inspect_harmony_hap_abc": {
        if (!isHapLoad(load)) throw new Error("unreachable");
        const extracted = await bridge.callJson(
          request.operation,
          "hap_read_abc",
          xpandaHapAbcSchema,
          {
            fileId: load.fileId,
            ...(request.input.entry === undefined
              ? {}
              : { entry: request.input.entry }),
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          entry: extracted.entry,
          cached: extracted.cached,
          runtime: extracted.runtime,
          bytecode_version: extracted.bytecodeVersion,
          class_count: extracted.classCount,
          class_name_preview: extracted.classesPreview,
          preview_truncated: extracted.previewTruncated,
          coverage: "hap_entry",
        };
      }
      case "inspect_harmony_hap_resources": {
        if (!isHapLoad(load)) throw new Error("unreachable");
        const resources = await bridge.callJson(
          request.operation,
          "hap_resources",
          xpandaHapResourcesSchema,
          {
            fileId: load.fileId,
            ...(request.input.name === undefined
              ? {}
              : { name: request.input.name }),
            ...(request.input.type === undefined
              ? {}
              : { type: request.input.type }),
            ...(request.input.limit_key === undefined
              ? {}
              : { limitKey: request.input.limit_key }),
            ...(request.input.id === undefined ? {} : { id: request.input.id }),
            offset: request.input.offset,
            limit: request.input.limit,
          },
          context,
        );
        return {
          analysis_timeout_ms: budget,
          engine: engineFacts,
          format: resources.format,
          version: resources.version,
          total: resources.total,
          matched: resources.matched,
          by_type: resources.byType,
          by_limit_key: resources.byLimitKey,
          offset: resources.offset,
          limit: resources.limit,
          returned: resources.items.length,
          truncated: resources.truncated,
          resources: resources.items.map(
            ({ id, name, type, limitKey, value }) => ({
              id,
              name,
              resource_type: type,
              limit_key: limitKey,
              value,
            }),
          ),
          coverage: "hap_resources",
        };
      }
    }
  }
}
