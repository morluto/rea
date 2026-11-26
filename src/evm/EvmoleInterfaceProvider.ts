import { finalizedResult, runOwned } from "../providers/runOwned.js";
import {
  capturedProviderOutput,
  providerResultDiagnostics,
} from "../process/capturedProviderOutput.js";
import { EvmAdmissionError } from "./EvmAdmissionError.js";
import { HOST_PLATFORM, type HostPlatform } from "../platform/HostPlatform.js";
import type { ProviderRejectionCode } from "../domain/providerSelection.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { safeParseUtf8Json } from "../domain/safeJson.js";
import { randomUUID } from "node:crypto";
import { access, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "../providers/classifyProviderFailure.js";
import {
  createAnalysisExecution,
  type ExecutionOptions,
  type ProviderAvailability,
} from "../ports/AnalysisProvider.js";
import type {
  EvmInterfaceExecution,
  EvmInterfacePort,
} from "../ports/evm/EvmInterfacePort.js";
import {
  completedStableArtifact,
  readStableArtifact,
  ArtifactResourceScope,
  ArtifactReaderFailure,
  artifactFileCancellationError,
  bindArtifactFileCleanup,
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../resources/index.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import {
  OwnedCommandFailure,
  ownedCommandResources,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
} from "../domain/analysisErrorBase.js";
import {
  type AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisTargetFailureError,
  AnalysisOutputError,
  cancelledBy,
  type AbortedSignal,
  unsupportedTarget,
} from "../domain/analysisErrorCore.js";
import { isAbortOf } from "../process/SignalAbort.js";
import {
  projectAnalysisError,
  projectAnalysisErrorWithoutCapturedOutput,
} from "../domain/analysisErrorProjection.js";
import { evmInterfaceEvidence } from "../domain/evm/evmInterfaceEvidence.js";
import {
  DEFAULT_EVM_TIMEOUT_MS,
  selectedEvmProducerLimits,
  type InspectEvmInterfaceInput,
  evmInterfaceSchema,
} from "../domain/evm/evmInterface.js";
import { solidityMetadataSchema } from "../domain/evm/solidityMetadata.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import {
  describeLinuxResourceLimitsFailure,
  readLinuxResourceLimits,
  type LinuxResourceLimits,
} from "../process/LinuxResourceLimits.js";
import {
  evmFailureDialect,
  evmReplyBudgetFailure,
  type EvmFileSizeFailureEvidence,
} from "./EvmoleFailures.js";
import {
  evmoleInterfaceReplySchema,
  projectEvmoleFunctions,
} from "./EvmoleInterfaceAdapter.js";
import {
  EVM_WORKER_HEAP_MIB,
  EVM_FILE_SIZE_FAILURE_EXIT,
} from "./EvmoleRelease.js";
import {
  EVMOLE_PROVIDER_IDENTITY,
  EVMOLE_VERSION,
} from "./EvmoleProviderIdentity.js";
import { decodeEvmBytecodeCarrier } from "./EvmBytecodeCarrier.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { sha256Hex } from "../kernel/sha256Hex.js";

const OPERATION = "inspect_evm_interface";

/** The caller's cancellation, observed as `signal`'s own abort. */
const abortedFailure = (
  signal: AbortedSignal,
  retainedOutput: AnalysisCapturedOutput | undefined,
): AnalysisCancelledError =>
  cancelledBy(
    OPERATION,
    signal,
    retainedOutput === undefined ? {} : { capturedOutput: retainedOutput },
  );
const HOST_REQUIREMENT =
  "Initial real-verified offline EVM interface profile supports Linux x64 only.";

/** The EVM interface profile runs only on Linux x64; discovery and execution share this check. */
export const evmHostSupported = (
  platform: NodeJS.Platform,
  arch: string,
): boolean => platform === "linux" && arch === "x64";
const EVM_PRLIMIT_COMMAND_DEFAULT = "/usr/bin/prlimit";

interface EvmLimiterProbeFileSystem {
  access(path: string, mode: number): Promise<void>;
  stat(path: string): Promise<{ isFile(): boolean }>;
}

interface EvmLimiterProbeOptions {
  /** The host the limiter would run on; it decides whether EVM analysis is supported. */
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly fs?: EvmLimiterProbeFileSystem;
  readonly signal?: AbortSignal;
}

type EvmLimiterSelection = {
  readonly path: string;
  readonly diagnostics: Readonly<Record<string, JsonValue>>;
};
type EvmLimiterUnavailable = EvmLimiterSelection & {
  readonly code: ProviderRejectionCode;
  readonly reason: string;
  readonly cause: unknown;
};

/** Select and validate the exact limiter using the same owner check at discovery and admission. */
const selectEvmLimiter = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  probes: {
    readonly platform: NodeJS.Platform;
    readonly arch: string;
    readonly fs?: EvmLimiterProbeFileSystem;
  },
  signal?: AbortSignal,
  operation = OPERATION,
): Promise<Result<EvmLimiterSelection, EvmLimiterUnavailable> | undefined> => {
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw cancelledBy(operation, signal);
  };
  throwIfAborted();
  const { platform, arch } = probes;
  if (!evmHostSupported(platform, arch)) return undefined;

  const path =
    environment.REA_EVM_PRLIMIT_COMMAND ?? EVM_PRLIMIT_COMMAND_DEFAULT;
  const diagnostics = { limiter_path: path, platform, arch };
  try {
    if (!isAbsolute(path))
      throw new EvmAdmissionError("prlimit_not_absolute", {
        setting: "REA_EVM_PRLIMIT_COMMAND",
      });
    const fs = probes.fs ?? { access, stat };
    await fs.access(path, constants.X_OK);
    throwIfAborted();
    if (!(await fs.stat(path)).isFile())
      throw new EvmAdmissionError("prlimit_not_file");
    throwIfAborted();
    return ok({ path, diagnostics });
  } catch (cause: unknown) {
    throwIfAborted();
    if (cause instanceof EvmAdmissionError)
      return err({
        path,
        code: "not_configured",
        diagnostics: {
          ...diagnostics,
          code: cause.code,
          ...cause.detail,
        },
        reason: `Set REA_EVM_PRLIMIT_COMMAND to an absolute executable regular file for caller-supplied util-linux prlimit. The selected path ${path} ${cause.code === "prlimit_not_absolute" ? "is not absolute" : "is not a regular file"}.`,
        cause,
      });
    const systemCode =
      cause instanceof Error &&
      "code" in cause &&
      typeof cause.code === "string"
        ? cause.code
        : undefined;
    const permissionDenied = systemCode === "EACCES" || systemCode === "EPERM";
    const missing = systemCode === "ENOENT" || systemCode === "ENOTDIR";
    const recovery = permissionDenied
      ? "Grant execute permission and filesystem access to the selected file, or set REA_EVM_PRLIMIT_COMMAND to an accessible absolute executable regular file for util-linux prlimit."
      : missing
        ? "Set REA_EVM_PRLIMIT_COMMAND to an existing absolute executable regular file for util-linux prlimit."
        : "Check the selected file and filesystem access, or set REA_EVM_PRLIMIT_COMMAND to an accessible absolute executable regular file for util-linux prlimit.";
    const reason = `Offline EVM interface inspection requires caller-supplied util-linux prlimit: ${path}; ${errorMessage(cause)}. ${recovery}`;
    return err({
      path,
      code: missing ? "executable_missing" : "runtime_unavailable",
      diagnostics: {
        ...diagnostics,
        ...(systemCode === undefined ? {} : { system_code: systemCode }),
      },
      reason,
      cause,
    });
  }
};

/** Fresh, process-free observation of the limiter prerequisite used by EVM execution. */
export const evmLimiterAvailability = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  probes: EvmLimiterProbeOptions,
): Promise<ProviderAvailability | undefined> => {
  const selected = await selectEvmLimiter(
    environment,
    probes,
    probes.signal,
    "binary_session",
  );
  if (selected === undefined) return undefined;
  return selected.ok
    ? {
        status: "available",
        code: null,
        reason: null,
        diagnostics: selected.value.diagnostics,
      }
    : {
        status: "unavailable",
        code: selected.error.code,
        reason: selected.error.reason,
        // The limiter owner does not yet author a separate repair (#8508).
        remediation: selected.error.reason,
        diagnostics: selected.error.diagnostics,
      };
};

const replySchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    version: z.literal(EVMOLE_VERSION),
    bytecode: z.strictObject({
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      bytes: z.int().nonnegative(),
      hex: z.string().regex(/^(?:[a-f0-9]{2})*$/),
      metadata: solidityMetadataSchema.optional(),
    }),
    raw: evmoleInterfaceReplySchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum(["malformed", "decoder", "output-limit", "unsupported"]),
    message: z.string(),
  }),
]);
type Launcher = NonNullable<Parameters<typeof runOwnedCommand>[2]>["launcher"];
type EvmOutcome = Result<EvmInterfaceExecution, AnalysisError>;
type EvmRuntimeRoot = Pick<PrivateRuntimeRoot, "path" | "close">;
type PendingEvmCleanup = {
  readonly input: InspectEvmInterfaceInput;
  readonly result: EvmOutcome;
  readonly output: AnalysisCapturedOutput | undefined;
  root:
    | { readonly owner: EvmRuntimeRoot; readonly lease: AnalysisCleanupLease }
    | undefined;
  process: AnalysisCleanupLease | undefined;
};

const ownerCleanupMarker = (
  owners: readonly AnalysisCleanupLease[],
): ProviderCleanupError =>
  new ProviderCleanupError(
    EVMOLE_PROVIDER_IDENTITY.id,
    owners.flatMap((owner) => owner.cleanupResources ?? ["owned-EVM-resource"]),
    { reason: "Exact EVM cleanup owners have not confirmed release." },
    { operation: OPERATION },
  );

const bindEvmCleanupOwners = (
  failure: AnalysisError,
  owners: readonly AnalysisCleanupLease[],
  primary?: AnalysisError,
): void => {
  const marker = ownerCleanupMarker(owners);
  new AnalysisCleanupLeaseGroup(marker, owners);
  failure.bindCleanupDependencies([
    marker,
    ...(primary?.cleanupIncomplete === true ? [primary] : []),
  ]);
};

const retainedCleanupFailure = (cause: unknown): ProviderCleanupError => {
  if (cause instanceof ProviderCleanupError) return cause;
  if (cause instanceof ArtifactReaderFailure) {
    const observation = ArtifactReaderFailure.cleanupObservation(
      cause,
      "EVM artifact resources",
    );
    const failure = new ProviderCleanupError(
      EVMOLE_PROVIDER_IDENTITY.id,
      observation.resources.length === 0
        ? ["EVM artifact resources"]
        : observation.resources,
      { reason: observation.reason },
      { operation: OPERATION, cause },
    );
    bindArtifactFileCleanup(cause, failure);
    return failure;
  }
  return new ProviderCleanupError(
    EVMOLE_PROVIDER_IDENTITY.id,
    cause instanceof AnalysisError && cause.cleanupResources.length > 0
      ? cause.cleanupResources
      : ["EVM provider cleanup"],
    { reason: errorMessage(cause) },
    {
      operation: OPERATION,
      cause,
      ...(cause instanceof AnalysisError ? { cleanupPrimary: cause } : {}),
    },
  );
};

const inheritedLimitsDialect = {
  providerId: EVMOLE_PROVIDER_IDENTITY.id,
  operation: OPERATION,
  readCleanup: (read, primary) => {
    const cleanup = retainedCleanupFailure(read);
    return primary === undefined
      ? cleanup
      : analysisErrorWithCleanupDependencies(primary, cleanup, OPERATION);
  },
  unclassified: (failure, details) => {
    const reason = describeLinuxResourceLimitsFailure(failure);
    return new AnalysisCapabilityUnavailableError(
      EVMOLE_PROVIDER_IDENTITY.id,
      OPERATION,
      reason,
      { ...details, cause: failure, userMessage: reason },
    );
  },
} satisfies ProviderFailureDialect;

const compactErrorProjection = (error: AnalysisError) => {
  const projection = projectAnalysisError(error);
  if (error.capturedOutput === undefined) return projection;
  // The cleanup result owns this exact captured stream. Other diagnostics and
  // partial Evidence retain their original fields, including stdout/stderr.
  const details = { ...projection.details };
  delete details.captured_output;
  return { ...projection, details };
};

const evmCleanupFailure = (
  input: InspectEvmInterfaceInput,
  result: EvmOutcome,
  resources: readonly string[],
  reason: string,
  output?: AnalysisCapturedOutput,
  cause?: unknown,
): ProviderCleanupError => {
  const partialObservation = result.ok
    ? evmInterfaceEvidence(input, result.value)
    : result.error.partialObservation;
  const capturedOutput = result.ok
    ? output
    : (result.error.capturedOutput ?? output);
  return new ProviderCleanupError(
    EVMOLE_PROVIDER_IDENTITY.id,
    resources,
    {
      reason,
      previous_error: result.ok ? null : compactErrorProjection(result.error),
      ...(capturedOutput === undefined
        ? {}
        : { captured_output: { ...capturedOutput } }),
    },
    {
      operation: OPERATION,
      ...(result.ok ? {} : { cleanupPrimary: result.error }),
      ...(cause === undefined ? {} : { cause }),
      ...(partialObservation === undefined ? {} : { partialObservation }),
    },
  );
};

/** The private reply owner separates completed bytes from descriptor finalization. */
const evmReplyCompletionFailure = (
  cause: ArtifactReaderFailure,
  capturedOutput: AnalysisCapturedOutput,
): AnalysisError => {
  const cancellation =
    cause.reason === "cancelled"
      ? artifactFileCancellationError(OPERATION, cause, { capturedOutput })
      : undefined;
  if (cause.cleanup === undefined) {
    if (cancellation !== undefined) return cancellation;
    return new AnalysisOutputError(
      OPERATION,
      "Owned EVM reply finalization failed.",
      { cause, capturedOutput },
    );
  }
  const cleanup = new ProviderCleanupError(
    EVMOLE_PROVIDER_IDENTITY.id,
    cause.cleanup.resources,
    { phase: "reply_descriptor_close", reason: cause.cleanup.reason },
    { operation: OPERATION, cause, capturedOutput },
  );
  bindArtifactFileCleanup(cause, cleanup);
  return cancellation === undefined
    ? cleanup
    : analysisErrorWithCleanupDependencies(cancellation, cleanup, OPERATION);
};

/** Run unchanged EVMole/WASM in an owned worker; no target, chain or network execution. */
export class EvmoleInterfaceProvider implements EvmInterfacePort {
  readonly #resources = new ArtifactResourceScope();
  #resourceScopeLease: AnalysisCleanupLease | undefined;
  #tail: Promise<void> = Promise.resolve();
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #pendingCleanup: PendingEvmCleanup | undefined;

  #artifactScopeLease(): AnalysisCleanupLease {
    if (this.#resourceScopeLease !== undefined) return this.#resourceScopeLease;
    const provider = this;
    const owner = {
      close: () => provider.#resources.close(),
      get cleanupResources() {
        return provider.#resources.cleanupResources;
      },
    };
    this.#resourceScopeLease = AnalysisCleanupLease.forCloseOwner(
      owner,
      "EVM artifact resources",
    );
    return this.#resourceScopeLease;
  }

  constructor(
    readonly environment: Readonly<NodeJS.ProcessEnv> = process.env,
    readonly launcher?: Launcher,
    readonly createRuntime: () => Promise<
      Pick<PrivateRuntimeRoot, "path" | "close">
    > = () => PrivateRuntimeRoot.create({ prefix: "rea-evm-interface-" }),
    /** The host the worker runs on; selects the supported-host gate and environment rules. */
    readonly host: HostPlatform = HOST_PLATFORM,
  ) {}

  /** Bind recovered interface candidates to both original carrier and decoded byte identity. */
  inspect(
    input: InspectEvmInterfaceInput,
    options?: ExecutionOptions,
  ): Promise<Result<EvmInterfaceExecution, AnalysisError>> {
    if (this.#closing) return Promise.resolve(err(this.#closedError()));
    const operation = this.#tail.then(async () => {
      if (this.#closing) return err(this.#closedError());
      const environment = snapshotEnvironment(
        this.environment,
        this.host.platform,
      );
      try {
        return await this.#resources.run(() =>
          this.#inspect(input, environment, options),
        );
      } catch (cause: unknown) {
        const failure = classifyProviderFailure(
          cause,
          evmFailureDialect({
            phase: "artifact-read",
            path: input.path,
            limiter:
              environment.REA_EVM_PRLIMIT_COMMAND ??
              EVM_PRLIMIT_COMMAND_DEFAULT,
            timeoutMs: input.timeout_ms ?? DEFAULT_EVM_TIMEOUT_MS,
            producerLimits: selectedEvmProducerLimits(input.producer_limits),
          }),
        );
        return err(failure);
      }
    });
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #inspect(
    input: InspectEvmInterfaceInput,
    environment: Readonly<NodeJS.ProcessEnv>,
    options?: ExecutionOptions,
  ): Promise<Result<EvmInterfaceExecution, AnalysisError>> {
    const pending = await this.#retire();
    if (pending !== undefined) return err(pending);
    let root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
    let rootLease: AnalysisCleanupLease | undefined;
    let processOwner: ProviderProcessSupervisor | undefined;
    let processCleanup:
      | {
          readonly reason: string;
          readonly resources: readonly string[];
        }
      | undefined;
    const processLeases = new WeakMap<
      ProviderProcessSupervisor,
      AnalysisCleanupLease
    >();
    const processLeaseFor = (owner: ProviderProcessSupervisor) => {
      let lease = processLeases.get(owner);
      if (lease === undefined) {
        lease = new AnalysisCleanupLease(
          async () => {
            const stopped = await owner.stop();
            if (
              stopped.status === "incomplete" ||
              stopped.status === "not-owned"
            )
              throw new EvmAdmissionError(
                stopped.status === "incomplete"
                  ? "cleanup_incomplete"
                  : "cleanup_unconfirmed",
                stopped.status === "incomplete"
                  ? { reason: stopped.reason }
                  : undefined,
                { cause: stopped },
              );
          },
          owner.launch.ownership === undefined
            ? ["owned-worker"]
            : ownedCommandResources(owner.launch.ownership, root?.path),
        );
        processLeases.set(owner, lease);
      }
      return lease;
    };
    const rootLeaseFor = (owner: EvmRuntimeRoot) => {
      rootLease ??= AnalysisCleanupLease.forCloseOwner(owner, owner.path);
      return rootLease;
    };
    const timeoutMs = input.timeout_ms ?? DEFAULT_EVM_TIMEOUT_MS;
    const producerLimits = selectedEvmProducerLimits(input.producer_limits);
    let retainedOutput: AnalysisCapturedOutput | undefined;
    let replyFinalization: AnalysisError | undefined;
    let phase: "configuration" | "artifact-read" | "worker" = "configuration";
    let workerLimits: LinuxResourceLimits | undefined;
    let limiter =
      environment.REA_EVM_PRLIMIT_COMMAND ?? EVM_PRLIMIT_COMMAND_DEFAULT;
    let result: Result<EvmInterfaceExecution, AnalysisError>;
    try {
      if (options?.signal?.aborted)
        throw cancelledBy(OPERATION, options.signal);
      if (!evmHostSupported(this.host.platform, this.host.architecture))
        throw new AnalysisCapabilityUnavailableError(
          EVMOLE_PROVIDER_IDENTITY.id,
          OPERATION,
          HOST_REQUIREMENT,
          { userMessage: HOST_REQUIREMENT },
        );
      const selectedLimiter = await selectEvmLimiter(
        environment,
        { platform: this.host.platform, arch: this.host.architecture },
        options?.signal,
      );
      if (selectedLimiter === undefined)
        throw new AnalysisCapabilityUnavailableError(
          EVMOLE_PROVIDER_IDENTITY.id,
          OPERATION,
          HOST_REQUIREMENT,
          { userMessage: HOST_REQUIREMENT },
        );
      if (!selectedLimiter.ok) {
        limiter = selectedLimiter.error.path;
        throw new AnalysisCapabilityUnavailableError(
          EVMOLE_PROVIDER_IDENTITY.id,
          OPERATION,
          selectedLimiter.error.reason,
          {
            cause: selectedLimiter.error.cause,
            diagnostics: selectedLimiter.error.diagnostics,
            userMessage: selectedLimiter.error.reason,
          },
        );
      }
      limiter = selectedLimiter.value.path;
      try {
        workerLimits = await readLinuxResourceLimits(
          producerLimits,
          this.#resources,
          options?.signal,
        );
      } catch (cause: unknown) {
        throw classifyProviderFailure(cause, inheritedLimitsDialect);
      }
      phase = "artifact-read";
      const carrier = await readStableArtifact(
        input.path,
        producerLimits.input_bytes,
        options?.signal,
        undefined,
        this.#resources,
      );
      phase = "worker";
      root = await this.createRuntime();
      rootLeaseFor(root);
      const snapshotPath = join(root.path, "carrier.snapshot");
      const requestPath = join(root.path, "request.json");
      const replyPath = join(root.path, "reply.json");
      await writeFile(snapshotPath, carrier.bytes, {
        flag: "wx",
        mode: 0o600,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      await writeFile(
        requestPath,
        JSON.stringify({
          snapshot_path: snapshotPath,
          reply_path: replyPath,
          failure_marker_path: join(root.path, "resource.failure"),
          encoding: input.encoding,
          producer_limits: producerLimits,
        }),
        { flag: "wx", mode: 0o600 },
      );
      const { NODE_OPTIONS: _ambientNodeOptions, ...workerEnvironment } =
        environment;
      const execution = await runOwnedCommand(
        {
          command: limiter,
          arguments: [
            `--as=${String(workerLimits.address_space_bytes)}:`,
            `--fsize=${String(workerLimits.file_bytes)}:`,
            "--core=0:",
            `--cpu=${String(workerLimits.cpu_seconds)}:`,
            "--",
            process.execPath,
            `--max-old-space-size=${String(EVM_WORKER_HEAP_MIB)}`,
            "--v8-pool-size=1",
            "--disable-wasm-trap-handler",
            fileURLToPath(
              new URL("./EvmoleInterfaceWorker.js", import.meta.url),
            ),
            requestPath,
          ],
          cwd: root.path,
          expectedCommand: null,
          runId: `rea-evm-interface-${randomUUID()}`,
          hostEnvironment: workerEnvironment,
        },
        {
          timeoutMs,
          diagnosticBytes: producerLimits.diagnostic_bytes,
          runtime: "v8",
        },
        {
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
          ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
          retainCleanup: (owner, cleanup) => {
            processOwner = owner;
            processLeaseFor(owner);
            processCleanup = {
              reason: cleanup.reason,
              resources:
                owner.launch.ownership === undefined
                  ? ["owned-worker"]
                  : ownedCommandResources(owner.launch.ownership, root?.path),
            };
          },
        },
      );
      const capturedOutput = capturedProviderOutput(execution);
      retainedOutput = capturedOutput;
      let reply: z.output<typeof replySchema>;
      try {
        let file;
        try {
          file = await readStableArtifact(
            replyPath,
            producerLimits.output_bytes,
            options?.signal,
            undefined,
            this.#resources,
          );
        } catch (cause: unknown) {
          const completed = completedStableArtifact(cause);
          if (
            !(cause instanceof ArtifactReaderFailure) ||
            completed === undefined
          )
            throw cause;
          file = completed;
          replyFinalization = evmReplyCompletionFailure(cause, capturedOutput);
        }
        const decoded = safeParseUtf8Json(file.bytes);
        if (!decoded.ok) throw decoded.cause;
        reply = replySchema.parse(decoded.value);
      } catch (cause: unknown) {
        const cleanup =
          cause instanceof ArtifactReaderFailure ? cause.cleanup : undefined;
        if (
          cause instanceof ArtifactReaderFailure &&
          cause.reason === "cancelled"
        ) {
          const failure = artifactFileCancellationError(OPERATION, cause, {
            capturedOutput,
            ...(cleanup === undefined ? {} : { cleanup }),
          });
          if (cause instanceof ArtifactReaderFailure)
            bindArtifactFileCleanup(cause, failure);
          throw failure;
        }
        const failure =
          cause instanceof ArtifactReaderFailure &&
          cause.reason === "limit" &&
          cause.boundary === "file-size"
            ? evmReplyBudgetFailure(
                cause.message,
                {
                  cause,
                  capturedOutput,
                  ...(cleanup === undefined ? {} : { cleanup }),
                },
                producerLimits,
              )
            : new AnalysisOutputError(
                OPERATION,
                `Owned interface worker reply failed for ${input.path}: ${errorMessage(cause)}`,
                {
                  cause,
                  capturedOutput,
                  ...(cleanup === undefined ? {} : { cleanup }),
                },
              );
        if (cause instanceof ArtifactReaderFailure)
          bindArtifactFileCleanup(cause, failure);
        throw failure;
      }
      if (!reply.ok) {
        if (reply.reason === "unsupported")
          throw unsupportedTarget(
            OPERATION,
            input.path,
            "evm-bytecode",
            reply.message,
            { capturedOutput },
          );
        // The worker rejected the selected bytecode, not the request.
        if (reply.reason === "malformed")
          throw new AnalysisTargetFailureError(
            OPERATION,
            input.path,
            {
              kind: "malformed",
              format: "evm-bytecode",
              detail: reply.message,
            },
            { capturedOutput },
          );
        if (reply.reason === "output-limit")
          throw evmReplyBudgetFailure(
            reply.message,
            {
              capturedOutput,
            },
            producerLimits,
          );
        throw new ProviderAdapterError(EVMOLE_PROVIDER_IDENTITY.id, OPERATION, {
          diagnostics: {
            phase,
            failure_kind: reply.reason,
            reason: reply.message,
            stdout: capturedOutput.stdout,
            stderr: capturedOutput.stderr,
            captured_output: { ...capturedOutput },
          },
        });
      }
      const selectedBytes = decodeEvmBytecodeCarrier(
        carrier.bytes,
        input.encoding,
      );
      const selectedHex = Buffer.from(selectedBytes).toString("hex");
      const decodedHash = sha256Hex(selectedBytes);
      if (
        decodedHash !== reply.bytecode.sha256 ||
        selectedHex !== reply.bytecode.hex ||
        selectedBytes.length !== reply.bytecode.bytes
      )
        throw new AnalysisOutputError(
          OPERATION,
          "Decoded bytecode representation does not match the selected carrier, encoding or reported SHA-256.",
          { capturedOutput },
        );
      const limitations = [
        `Configured worker resource soft limits: address_space_bytes=${String(workerLimits.address_space_bytes)}, cpu_seconds=${String(workerLimits.cpu_seconds)}, file_size_bytes=${String(workerLimits.file_bytes)}. Selected from inherited tighter limits; original hard limits are retained. Effective worker limits are not independently probed.`,
        "Upstream may also report terminal metadata while recovering selectors. Its reported values are retained in raw_result, but integer precision and non-text-key coverage are unknown in the JS binding; complete original bytecode remains available.",
        "Recovered selectors, argument strings and mutability are upstream inferences, not verified ABI signatures or names. Empty results do not prove the absence of callable dispatch.",
        "Bytecode kind, hardfork and deployed-contract authenticity are unknown. This inspection performs no target runtime execution, chain/RPC lookup or network request.",
        "Original carrier and decoded bytecode SHA-256 are distinct identities; SHA-256 is not the Ethereum Keccak code hash.",
        "Terminal CBOR metadata is an independently decoded candidate, not proof of Solidity origin, source identity or deployment. Nested or unsupported values retain explicit unavailable interpretation and original byte ranges.",
        `The owned worker has a 256 MiB JavaScript heap. The profile maxima are ${String(producerLimits.address_space_bytes)} address-space bytes and ${String(producerLimits.cpu_seconds)} CPU seconds; the configured soft limits above retain tighter inherited limits. The command deadline is timeout_ms at ${String(timeoutMs)} ms (default ${String(DEFAULT_EVM_TIMEOUT_MS)}). producer_limits can change those requested byte, address-space and CPU allowances on the next call without restart; timeout_ms does not raise them. The 256 MiB worker heap remains independent. Virtual address space is distinct from resident memory; limits fail without partial success.`,
      ];
      const validated = evmInterfaceSchema.safeParse({
        artifact: {
          path: input.path,
          sha256: carrier.sha256,
          bytes: carrier.bytes.length,
          encoding: input.encoding,
        },
        bytecode: {
          ...reply.bytecode,
          digest_algorithm: "sha256",
          kind: "unknown",
          deployment_authenticity: "unknown",
          hardfork: "unknown",
        },
        evidence_kind: "inferred",
        functions: projectEvmoleFunctions(reply.raw),
        discovery_completeness: "unknown",
        runtime_execution: "not-performed",
        diagnostics: providerResultDiagnostics(capturedOutput),
        limitations,
      });
      if (!validated.success)
        throw new AnalysisOutputError(
          OPERATION,
          `Interface worker returned invalid bytecode-relative evidence: ${validated.error.issues[0]?.message ?? "schema mismatch"}`,
          { capturedOutput },
        );
      const report = validated.data;
      result = ok(
        createAnalysisExecution(report, EVMOLE_PROVIDER_IDENTITY, {
          rawResult: reply.raw,
          subject: { path: input.path, format: "file", sha256: carrier.sha256 },
          locations: [{ kind: "artifact-path", path: input.path }],
          limitations,
        }),
      );
    } catch (cause: unknown) {
      if (
        cause instanceof OwnedCommandFailure &&
        cause.cleanupOwner !== undefined
      ) {
        processOwner = cause.cleanupOwner;
        processLeaseFor(cause.cleanupOwner);
      }
      let fileFailure: EvmFileSizeFailureEvidence | undefined;
      let markerCleanupFailure: ArtifactReaderFailure | undefined;
      if (
        cause instanceof OwnedCommandFailure &&
        cause.snapshot?.exitCode === EVM_FILE_SIZE_FAILURE_EXIT &&
        cause.snapshot.signal === null &&
        cause.cleanupOwner === undefined &&
        cause.cleanupFailure === null &&
        processOwner === undefined &&
        root !== undefined
      ) {
        try {
          let marker;
          try {
            marker = await readStableArtifact(
              join(root.path, "resource.failure"),
              1,
              undefined,
              undefined,
              this.#resources,
            );
          } catch (markerFailure: unknown) {
            if (
              markerFailure instanceof ArtifactReaderFailure &&
              markerFailure.cleanup !== undefined
            )
              markerCleanupFailure = markerFailure;
            const completed = completedStableArtifact(markerFailure);
            if (completed === undefined) throw markerFailure;
            marker = completed;
          }
          if (!marker.bytes.equals(Buffer.from("F")))
            throw new EvmAdmissionError("marker_mismatch");
          fileFailure = { verified: true, failure: null };
        } catch (markerFailure: unknown) {
          fileFailure = {
            verified: false,
            failure: errorMessage(markerFailure),
          };
        }
      }
      // Only this caller's own abort is a cancellation; an abort error with
      // another reason is classified as the failure it is.
      const signal = options?.signal;
      let failure = isAbortOf(cause, signal)
        ? abortedFailure(signal, retainedOutput)
        : // Owns the selected carrier's cleanup binding and snapshot identity.
          classifyProviderFailure(
            cause,
            evmFailureDialect({
              phase,
              path: input.path,
              workerLimits,
              limiter,
              fileFailure,
              timeoutMs,
              producerLimits,
            }),
          );
      if (markerCleanupFailure !== undefined) {
        const cleanup = retainedCleanupFailure(markerCleanupFailure);
        failure = analysisErrorWithCleanupDependencies(
          failure,
          cleanup,
          OPERATION,
        );
      }
      result = err(failure);
    }
    if (replyFinalization !== undefined) {
      if (result.ok) {
        replyFinalization.retainPartialObservation(
          evmInterfaceEvidence(input, result.value),
        );
        result = err(replyFinalization);
      } else {
        result = err(
          replyFinalization.cleanupIncomplete
            ? analysisErrorWithCleanupDependencies(
                result.error,
                replyFinalization,
                OPERATION,
              )
            : result.error.retainSecondaryFailure(replyFinalization, {
                reply_finalization_error:
                  projectAnalysisErrorWithoutCapturedOutput(replyFinalization),
              }),
        );
      }
    }
    let rootCleanup:
      | { readonly owner: EvmRuntimeRoot; readonly lease: AnalysisCleanupLease }
      | undefined;
    const finalized = await runOwned(async () => result, {
      providerId: EVMOLE_PROVIDER_IDENTITY.id,
      operation: OPERATION,
      signal: options?.signal,
      partial: (execution) => evmInterfaceEvidence(input, execution),
      capturedOutput: (_execution, replacement) =>
        replacement === "cancellation" ? retainedOutput : undefined,
      close: async () => {
        if (root === undefined || processOwner !== undefined) return;
        const lease = rootLeaseFor(root);
        try {
          await lease.release();
        } catch (cause: unknown) {
          rootCleanup = { owner: root, lease };
          const failure = result.ok
            ? evmCleanupFailure(
                input,
                result,
                [root.path],
                errorMessage(cause),
                retainedOutput,
                cause,
              )
            : new ProviderCleanupError(
                EVMOLE_PROVIDER_IDENTITY.id,
                [root.path],
                { reason: errorMessage(cause) },
                { operation: OPERATION, cause },
              );
          bindEvmCleanupOwners(failure, [lease]);
          throw failure;
        }
      },
      composeCleanupFailure: (primary, cleanup) =>
        evmCleanupFailure(
          input,
          err(primary),
          cleanup.cleanupResources,
          errorMessage(cleanup.cause),
          retainedOutput,
          cleanup.cause,
        ),
    });
    if (rootCleanup !== undefined) {
      const cleanup = rootCleanup;
      const primary =
        finalized.kind === "completed-cleanup-retained"
          ? ok(finalized.value)
          : finalized.kind === "failed" || finalized.kind === "cancelled"
            ? err(finalized.error.cleanupPrimary ?? finalized.error)
            : result;
      this.#pendingCleanup = {
        input,
        result: primary,
        output: retainedOutput,
        root: cleanup,
        process: undefined,
      };
    }
    result = finalizedResult(finalized);
    if (processOwner !== undefined) {
      const lease = processLeaseFor(processOwner);
      const rootOwnerLease =
        root === undefined ? undefined : rootLeaseFor(root);
      this.#pendingCleanup = {
        input,
        result,
        output: retainedOutput,
        root:
          root === undefined || rootOwnerLease === undefined
            ? undefined
            : { owner: root, lease: rootOwnerLease },
        process: lease,
      };
      if (processCleanup === undefined) {
        const owners = [lease, rootOwnerLease].filter(
          (owner): owner is AnalysisCleanupLease => owner !== undefined,
        );
        if (!result.ok && result.error.cleanupIncomplete) {
          bindEvmCleanupOwners(result.error, owners);
          return result;
        }
        const failure = evmCleanupFailure(
          input,
          result,
          [
            ...new Set([
              ...(root === undefined ? [] : [root.path]),
              ...(lease.cleanupResources ?? []),
            ]),
          ],
          "Owned EVM worker cleanup remained unresolved without a failure description.",
          retainedOutput,
          processOwner,
        );
        bindEvmCleanupOwners(
          failure,
          owners,
          result.ok ? undefined : result.error,
        );
        return err(failure);
      }
      const failure = evmCleanupFailure(
        input,
        result,
        [
          ...new Set([
            ...(root === undefined ? [] : [root.path]),
            ...processCleanup.resources,
          ]),
        ],
        processCleanup.reason,
        retainedOutput,
        processOwner,
      );
      bindEvmCleanupOwners(
        failure,
        [lease, rootOwnerLease].filter(
          (lease): lease is AnalysisCleanupLease => lease !== undefined,
        ),
        result.ok ? undefined : result.error,
      );
      return err(failure);
    }
    return result;
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#tail
      .then(async () => {
        const [retirement, artifacts] = await Promise.allSettled([
          this.#retire(),
          this.#artifactScopeLease().release(),
        ]);
        const failures: AnalysisError[] = [];
        if (retirement.status === "rejected")
          failures.push(retainedCleanupFailure(retirement.reason));
        else if (retirement.value !== undefined)
          failures.push(retirement.value);
        if (artifacts.status === "rejected") {
          const scopeLease = this.#artifactScopeLease();
          const artifactFailure = retainedCleanupFailure(artifacts.reason);
          const marker = ownerCleanupMarker([scopeLease]);
          new AnalysisCleanupLeaseGroup(marker, [scopeLease]);
          artifactFailure.bindCleanupDependencies([marker]);
          failures.push(artifactFailure);
        }
        if (failures.length > 0) {
          const resources = failures.flatMap((failure) =>
            failure instanceof ProviderCleanupError
              ? failure.cleanupResources
              : failure instanceof ArtifactReaderFailure &&
                  failure.cleanup !== undefined
                ? failure.cleanup.resources
                : ["artifact-resources"],
          );
          const failure = new ProviderCleanupError(
            EVMOLE_PROVIDER_IDENTITY.id,
            [...new Set(resources)],
            {
              failures: failures.map((failure) => errorMessage(failure)),
            },
            { operation: OPERATION, cause: new AggregateError(failures) },
          );
          failure.bindCleanupDependencies(failures);
          throw failure;
        }
      })
      .catch((cause: unknown) => {
        this.#closePromise = undefined;
        throw cause;
      });
    return this.#closePromise;
  }

  #closedError(): AnalysisCapabilityUnavailableError {
    return new AnalysisCapabilityUnavailableError(
      EVMOLE_PROVIDER_IDENTITY.id,
      OPERATION,
      "Provider is closing; create a new EVM inspection service.",
    );
  }

  async #retire(): Promise<ProviderCleanupError | undefined> {
    const pending = this.#pendingCleanup;
    if (pending === undefined) return undefined;
    if (pending.process !== undefined) {
      try {
        await pending.process.release();
      } catch (cause: unknown) {
        const failure = evmCleanupFailure(
          pending.input,
          pending.result,
          [
            ...new Set([
              ...(pending.root === undefined ? [] : [pending.root.owner.path]),
              ...(pending.process.cleanupResources ?? []),
            ]),
          ],
          errorMessage(cause),
          pending.output,
          cause,
        );
        bindEvmCleanupOwners(
          failure,
          [
            pending.process,
            ...(pending.root === undefined ? [] : [pending.root.lease]),
          ],
          pending.result.ok ? undefined : pending.result.error,
        );
        return failure;
      }
      pending.process = undefined;
    }
    if (pending.root !== undefined) {
      const { owner: root, lease } = pending.root;
      try {
        await lease.release();
        pending.root = undefined;
      } catch (cause: unknown) {
        const failure = evmCleanupFailure(
          pending.input,
          pending.result,
          lease.cleanupResources ?? [root.path],
          errorMessage(cause),
          pending.output,
          cause,
        );
        bindEvmCleanupOwners(
          failure,
          [lease],
          pending.result.ok ? undefined : pending.result.error,
        );
        return failure;
      }
    }
    this.#pendingCleanup = undefined;
    return undefined;
  }
}
