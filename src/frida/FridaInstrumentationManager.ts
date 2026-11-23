import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
  Device,
  DeviceManager,
  FridaMessage,
  RemoteDeviceOptions,
  Script,
  Session,
} from "frida";

import type {
  FridaDeviceObservation,
  FridaDeviceSelector,
  FridaInstrumentationPort,
  FridaProcessObservation,
  FridaRemoteConnection,
  FridaScriptObservation,
  FridaScriptSource,
  FridaSessionObservation,
  FridaSessionStatus,
  StartFridaSessionInput,
} from "../ports/frida/FridaInstrumentationPort.js";
import { FridaScriptLoadCancelledError } from "../ports/frida/FridaInstrumentationPort.js";
import type { OptionalProviderLoadFailure } from "../ports/OptionalObservationProviders.js";
import {
  AnalysisAccessDeniedError,
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisTimeoutError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { isValidFridaRemoteAddress } from "../domain/fridaRemoteAddress.js";
import { redactExplicitFailure } from "../domain/explicitSensitiveFailure.js";
import {
  explicitValueSpans,
  explicitValuesOccurIn,
} from "../domain/explicitSensitiveValues.js";
import { providerCleanupErrorFromFailures } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { AnalysisCleanupLease } from "../resources/index.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { jsonStringByteLength } from "../domain/jsonStringByteLength.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  unknownFridaScript,
  unknownFridaSession,
} from "../domain/fridaInputErrors.js";
import {
  MAX_MESSAGE_METADATA_BYTES,
  type FridaOwnedCaptureLimit,
} from "../domain/fridaCaptureLimits.js";
import {
  resolveFridaCapturePolicy,
  type FridaCapturePolicy,
} from "../domain/fridaCapturePolicy.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { FifoQueue } from "../kernel/FifoQueue.js";
import { sha256Hex } from "../kernel/sha256Hex.js";

const DEVICE_LOOKUP_TIMEOUT_MS = 1_000;

/**
 * Frida Core 17.23.2 raises this from `getDeviceById` only after the supplied
 * timeout elapses without a match. A closed manager or backend failure uses a
 * different message and is not this deadline.
 */
const FRIDA_DEVICE_LOOKUP_TIMEOUT_MESSAGE = "Device not found";

const isFridaDeviceLookupTimeout = (cause: unknown): boolean =>
  cause instanceof Error &&
  cause.message === FRIDA_DEVICE_LOOKUP_TIMEOUT_MESSAGE;

interface ScriptMessageCapture {
  readonly messages: FifoQueue<JsonValue>;
  truncated: boolean;
}

interface ManagedScript {
  readonly id: string;
  readonly name: string;
  readonly script: Script;
  readonly onMessage: (message: FridaMessage, data: Buffer | null) => void;
  state: "active" | "cleanup-pending" | "released";
}

interface ManagedRemoteConnection {
  readonly deviceManager: DeviceManager;
  readonly remote: FridaRemoteConnection | undefined;
  remoteReferenceHeld: boolean;
  remoteRemovalPending: boolean;
}

interface PendingStartupCleanup extends ManagedRemoteConnection {
  readonly id: string;
  readonly device: Device;
  spawnedPid: number | undefined;
  session: Session | undefined;
}

interface ManagedSession extends ManagedRemoteConnection {
  readonly captureLimits: FridaCapturePolicy;
  readonly secrets: readonly string[];
  readonly id: string;
  readonly device: Device;
  readonly session: Session;
  readonly target: string;
  readonly pid: number;
  readonly mode: "attach" | "spawn";
  readonly scripts: Map<string, ManagedScript>;
  readonly messages: FifoQueue<CapturedMessage>;
  readonly scriptCaptures: Map<string, ScriptMessageCapture>;
  /** Once close begins, this session is retained only for cleanup. */
  cleanupStarted: boolean;
  detached: boolean;
  targetResumeObserved: boolean;
  resumeAfterDetachPending: boolean;
  capturedBytes: number;
  messagesTruncated: boolean;
}

export interface FridaInstrumentationManagerOptions {
  readonly deviceManager?: DeviceManager;
  readonly deviceManagerLoader?: () => Promise<DeviceManager>;
}

/** Owns Frida sessions and their scripts without owning target process lifetime. */
export class FridaInstrumentationManager implements FridaInstrumentationPort {
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #pendingStartups = new Set<PendingStartupCleanup>();
  readonly #cleanupLeases = new WeakMap<object, AnalysisCleanupLease>();
  readonly #sessionQueues = new Map<string, Promise<void>>();
  readonly #sessionClosures = new Map<
    string,
    Promise<Result<{ readonly targetResumeObserved: boolean }, AnalysisError>>
  >();
  readonly #remoteDevices = new Map<
    string,
    {
      id: string;
      references: number;
      optionsDigest: string;
      device: Promise<Device>;
    }
  >();
  readonly #remoteQueues = new Map<string, Promise<void>>();
  readonly #deviceManagerLoader: () => Promise<DeviceManager>;
  #deviceManager: DeviceManager | undefined;
  #deviceManagerLoading: Promise<DeviceManager> | undefined;
  #availabilityFailure: OptionalProviderLoadFailure | undefined;
  readonly #operations = new Set<Promise<unknown>>();
  #closing = false;
  #closeAllPromise: Promise<void> | undefined;

  constructor(options: FridaInstrumentationManagerOptions = {}) {
    this.#deviceManager = options.deviceManager;
    this.#deviceManagerLoader =
      options.deviceManagerLoader ??
      (async () => (await import("frida")).getDeviceManager());
  }

  availabilityFailure(): OptionalProviderLoadFailure | undefined {
    return this.#availabilityFailure;
  }

  listDevices(remote?: FridaRemoteConnection) {
    return this.#withOperation("list_frida_devices", () =>
      this.#listDevices(remote),
    );
  }

  async #listDevices(remote?: FridaRemoteConnection): Promise<
    Result<
      {
        readonly devices: readonly FridaDeviceObservation[];
        readonly cleanupError: string | null;
      },
      AnalysisError
    >
  > {
    let manager: DeviceManager | undefined;
    let remoteHeld = false;
    try {
      manager = await this.#getDeviceManager();
      if (remote !== undefined) {
        await this.#retainRemote(manager, remote);
        remoteHeld = true;
      }
      const devices = await manager.enumerateDevices();
      let cleanupError: string | null = null;
      if (manager !== undefined && remoteHeld && remote !== undefined) {
        try {
          await this.#releaseRemote(manager, remote.address);
          remoteHeld = false;
        } catch (cause: unknown) {
          cleanupError = sanitizeError(cause, remote);
        }
      }
      return ok({
        devices: devices.map((device) => ({
          deviceId: device.id,
          name: device.name,
          type: device.type,
        })),
        cleanupError,
      });
    } catch (cause: unknown) {
      let cleanupError: string | undefined;
      if (manager !== undefined && remoteHeld && remote !== undefined) {
        try {
          await this.#releaseRemote(manager, remote.address);
        } catch (cleanupCause: unknown) {
          cleanupError = sanitizeError(cleanupCause, remote);
        }
      }
      const failure = providerError(
        "list_frida_devices",
        cause,
        remote,
        cleanupError,
        remote === undefined ? undefined : { remote },
      );
      const reference =
        remote === undefined
          ? undefined
          : this.#remoteDevices.get(remote.address);
      if (reference !== undefined && failure.cleanupIncomplete)
        this.#retainCleanupFailure(reference, failure);
      return err(failure);
    }
  }

  listProcesses(selector: FridaDeviceSelector) {
    return this.#withOperation("list_frida_processes", () =>
      this.#listProcesses(selector),
    );
  }

  async #listProcesses(selector: FridaDeviceSelector): Promise<
    Result<
      {
        readonly deviceId: string;
        readonly processes: readonly FridaProcessObservation[];
        readonly cleanupError: string | null;
      },
      AnalysisError
    >
  > {
    let manager: DeviceManager | undefined;
    let remoteHeld = false;
    try {
      manager = await this.#getDeviceManager();
      const device = await this.#selectDevice(manager, selector);
      remoteHeld = selector.remote !== undefined;
      const processes = await device.enumerateProcesses();
      let cleanupError: string | null = null;
      if (remoteHeld && selector.remote !== undefined) {
        try {
          await this.#releaseRemote(manager, selector.remote.address);
          remoteHeld = false;
        } catch (cause: unknown) {
          cleanupError = sanitizeError(cause, selector.remote);
        }
      }
      return ok({
        deviceId: device.id,
        processes: processes.map((process) => ({
          pid: process.pid,
          name: process.name,
          identifier: null,
        })),
        cleanupError,
      });
    } catch (cause: unknown) {
      let cleanupError: string | undefined;
      if (
        manager !== undefined &&
        remoteHeld &&
        selector.remote !== undefined
      ) {
        try {
          await this.#releaseRemote(manager, selector.remote.address);
        } catch (cleanupCause: unknown) {
          cleanupError = sanitizeError(cleanupCause, selector.remote);
        }
      }
      const failure = providerError(
        "list_frida_processes",
        cause,
        selector.remote,
        cleanupError,
        selector,
      );
      const reference =
        selector.remote === undefined
          ? undefined
          : this.#remoteDevices.get(selector.remote.address);
      if (reference !== undefined && failure.cleanupIncomplete)
        this.#retainCleanupFailure(reference, failure);
      return err(failure);
    }
  }

  startSession(input: StartFridaSessionInput) {
    return this.#withOperation("start_frida_session", () =>
      this.#startSession(input),
    );
  }

  async #startSession(
    input: StartFridaSessionInput,
  ): Promise<Result<FridaSessionObservation, AnalysisError>> {
    const policy = resolveFridaCapturePolicy(input.captureLimits ?? {});
    if (!policy.success)
      return err(
        analysisInputErrorFromIssues(
          "start_frida_session",
          policy.error.issues.map((issue) => ({
            ...issue,
            path: ["capture_limits", ...issue.path],
          })),
          { capture_limits: input.captureLimits },
        ),
      );
    let manager: DeviceManager | undefined;
    let device: Device | undefined;
    let remoteHeld = false;
    let spawnedPid: number | undefined;
    let session: Session | undefined;
    try {
      manager = await this.#getDeviceManager();
      device = await this.#selectDevice(manager, input);
      remoteHeld = input.remote !== undefined;
      let pid: number;
      let target: string;
      if (input.mode === "attach") {
        pid = input.pid;
        target = `pid ${pid}`;
        try {
          const process = await device.getProcessByPid(pid);
          target = `${process.name} (pid ${pid})`;
        } catch {
          // Frida can attach to processes absent from its enumeration snapshot.
        }
      } else {
        pid = await device.spawn(
          input.program,
          input.argv === undefined
            ? undefined
            : { argv: [input.program, ...input.argv] },
        );
        spawnedPid = pid;
        target = input.program;
      }
      session = await device.attach(pid);
      const id = randomUUID();
      const managed: ManagedSession = {
        id,
        captureLimits: policy.data,
        secrets: remoteSecrets(input.remote),
        device,
        deviceManager: manager,
        remote: input.remote,
        remoteReferenceHeld: remoteHeld,
        remoteRemovalPending: false,
        session,
        target,
        pid,
        mode: input.mode,
        scripts: new Map(),
        messages: new FifoQueue(),
        scriptCaptures: new Map(),
        cleanupStarted: false,
        detached: false,
        targetResumeObserved: false,
        resumeAfterDetachPending: false,
        capturedBytes: 0,
        messagesTruncated: false,
      };
      session.detached.connect(() => {
        managed.detached = true;
      });
      // A target can exit while metadata lookup/attach is pending, before
      // Frida installs this listener. Subscribe first, then reconcile the
      // current provider state so an already-emitted detach is not lost.
      if (session.isDetached()) managed.detached = true;
      this.#sessions.set(id, managed);
      return ok(sessionObservation(managed));
    } catch (cause: unknown) {
      let cleanupFailures: readonly string[] = [];
      let pendingCleanup: PendingStartupCleanup | undefined;
      if (
        manager !== undefined &&
        device !== undefined &&
        (spawnedPid !== undefined || session !== undefined || remoteHeld)
      ) {
        const pending: PendingStartupCleanup = {
          id: randomUUID(),
          device,
          deviceManager: manager,
          remote: input.remote,
          remoteReferenceHeld: remoteHeld,
          remoteRemovalPending: false,
          spawnedPid,
          session,
        };
        // Keep the original provider handles until every acquired resource is
        // released, including failures before a session can be registered.
        this.#pendingStartups.add(pending);
        pendingCleanup = pending;
        cleanupFailures = await this.#cleanupStartup(pending);
      }
      const failure = providerError(
        "start_frida_session",
        cause,
        input.remote,
        cleanupFailures.join("; ") || undefined,
        input,
      );
      if (pendingCleanup !== undefined && failure.cleanupIncomplete)
        this.#retainCleanupFailure(pendingCleanup, failure);
      return err(failure);
    }
  }

  loadScript(
    sessionId: string,
    source: FridaScriptSource,
    signal?: AbortSignal,
  ): Promise<Result<FridaScriptObservation, AnalysisError>> {
    return this.#withOperation(
      "load_frida_script",
      () =>
        this.#withSessionLock(sessionId, () =>
          this.#loadScript(sessionId, source, signal),
        ),
      signal,
    );
  }

  async #loadScript(
    sessionId: string,
    source: FridaScriptSource,
    signal?: AbortSignal,
  ): Promise<Result<FridaScriptObservation, AnalysisError>> {
    if (signal?.aborted)
      return err(cancelledOperation("load_frida_script", signal));
    const admitted = this.#admitSessionWork(sessionId, "load_frida_script");
    if (!admitted.ok) return admitted;
    const managed = admitted.value;

    let scriptSource: string;
    let sourceSha256: string;
    let sourceRepresentation: FridaScriptObservation["sourceRepresentation"];
    try {
      const selectedSource =
        source.sourceKind === "inline"
          ? source.source
          : await readFile(source.path);
      sourceSha256 = sha256Hex(selectedSource);
      scriptSource =
        typeof selectedSource === "string"
          ? selectedSource
          : selectedSource.toString("utf8");
      if (typeof selectedSource !== "string" && !isUtf8(selectedSource))
        sourceRepresentation = {
          encoding: "utf8",
          decoding: "replacement",
          loadedSourceSha256: sha256Hex(scriptSource),
        };
    } catch (cause: unknown) {
      const sourcePath = source.sourceKind === "file" ? source.path : undefined;
      return err(
        cause instanceof Error &&
          "code" in cause &&
          (cause.code === "EACCES" || cause.code === "EPERM")
          ? new AnalysisAccessDeniedError(
              "load_frida_script",
              sourcePath ?? "<inline>",
              cause.code,
              { cause },
            )
          : new AnalysisInputError("load_frida_script", { cause }, [
              {
                path: ["path"],
                reason: "invalid_value",
                message: `Cannot read Frida script file ${sourcePath ?? "<inline>"}.`,
              },
            ]),
      );
    }

    if (signal?.aborted)
      return err(cancelledOperation("load_frida_script", signal));
    const scriptId = randomUUID();
    const capture: ScriptMessageCapture = {
      messages: new FifoQueue(),
      truncated: false,
    };
    managed.scriptCaptures.set(scriptId, capture);
    const onMessage = (message: FridaMessage, data: Buffer | null): void => {
      this.#recordMessage(managed, scriptId, message, data);
    };
    let entry: ManagedScript | undefined;
    let nativeFailure: { readonly cause: unknown } | undefined;
    try {
      const nativeScript = await managed.session.createScript(scriptSource, {
        name: `rea-${scriptId}`,
      });
      entry = {
        id: scriptId,
        name: `rea-${scriptId}`,
        script: nativeScript,
        onMessage,
        state: "active",
      };
      managed.scripts.set(scriptId, entry);
      nativeScript.message.connect(onMessage);
      if (!signal?.aborted) await nativeScript.load();
    } catch (cause: unknown) {
      nativeFailure = { cause };
    }
    // Settle the primary outcome before cleanup: a later abort cannot replace
    // an already observed native failure. Keep the capture through cleanup,
    // including callbacks emitted while unload/disconnect are completing.
    const cancellation = signal?.aborted
      ? { reason: signal.reason }
      : undefined;
    let cleanupReason: string | undefined;
    if (nativeFailure !== undefined || cancellation !== undefined) {
      if (entry === undefined) managed.scriptCaptures.delete(scriptId);
      else cleanupReason = await this.#releaseScript(managed, entry);
    }
    if (nativeFailure !== undefined && cancellation === undefined) {
      const failure = providerError(
        "load_frida_script",
        nativeFailure.cause,
        managed.remote,
        cleanupReason,
      );
      if (entry !== undefined && failure.cleanupIncomplete)
        this.#retainCleanupFailure(entry, failure);
      return err(failure);
    }
    const observation: FridaScriptObservation = {
      scriptId,
      captureLimits: managed.captureLimits,
      sourceKind: source.sourceKind,
      sourcePath: source.sourceKind === "file" ? source.path : null,
      sourceSha256,
      ...(sourceRepresentation === undefined ? {} : { sourceRepresentation }),
      messages: capture.messages.toArray(),
      messagesTruncated: capture.truncated,
    };
    if (cancellation !== undefined) {
      const failure = new FridaScriptLoadCancelledError(observation, {
        cause: cancellation.reason,
        scriptHandleAcquired: entry !== undefined,
        ...(nativeFailure === undefined
          ? {}
          : {
              diagnostics: {
                native_failure: sanitizeError(
                  nativeFailure.cause,
                  managed.remote,
                ),
              },
            }),
        ...(cleanupReason === undefined
          ? {}
          : {
              cleanup: {
                reason: cleanupReason,
                resources: [sessionId, scriptId],
              },
            }),
      });
      if (entry !== undefined && failure.cleanupIncomplete)
        this.#retainCleanupFailure(entry, failure);
      return err(failure);
    }
    return ok(observation);
  }

  resumeSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<Result<null, AnalysisError>> {
    return this.#withOperation(
      "resume_frida_session",
      () =>
        this.#withSessionLock(sessionId, () =>
          signal?.aborted
            ? Promise.resolve(
                err(cancelledOperation("resume_frida_session", signal)),
              )
            : this.#resumeSession(sessionId),
        ),
      signal,
    );
  }

  async #resumeSession(
    sessionId: string,
  ): Promise<Result<null, AnalysisError>> {
    const admitted = this.#admitSessionWork(sessionId, "resume_frida_session");
    if (!admitted.ok) return admitted;
    const managed = admitted.value;
    if (managed.mode !== "spawn" || managed.targetResumeObserved)
      return err(
        new AnalysisInputError(
          "resume_frida_session",
          {
            userMessage:
              "Only a paused process spawned by this session can be resumed.",
          },
          [
            {
              path: ["session_id"],
              reason: "invalid_value",
              message: "Select a paused process spawned by this session.",
            },
          ],
        ),
      );
    const pendingScripts = [...managed.scripts.values()].filter(
      (entry) => entry.state === "cleanup-pending" && !entry.script.isDestroyed,
    );
    if (pendingScripts.length > 0) {
      const reason =
        "Frida script cleanup is incomplete; unload the retained scripts or close the session before resuming.";
      return err(
        new AnalysisCapabilityUnavailableError(
          "frida",
          "resume_frida_session",
          reason,
          {
            cleanup: {
              reason,
              resources: pendingScripts.map((entry) => entry.id),
            },
          },
        ),
      );
    }
    try {
      await managed.device.resume(managed.pid);
      managed.targetResumeObserved = true;
      managed.resumeAfterDetachPending = false;
      return ok(null);
    } catch (cause: unknown) {
      return err(providerError("resume_frida_session", cause, managed.remote));
    }
  }

  #admitSessionWork(
    sessionId: string,
    operation: "load_frida_script" | "resume_frida_session",
  ): Result<ManagedSession, AnalysisError> {
    const managed = this.#sessions.get(sessionId);
    if (managed === undefined)
      return err(unknownFridaSession(operation, sessionId));
    if (managed.cleanupStarted) {
      const message = `Frida session ${sessionId} is retained for cleanup.`;
      return err(
        new AnalysisCapabilityUnavailableError("frida", operation, message, {
          userMessage: message,
          remediationAction: `Retry close_frida_session with session_id ${sessionId} to finish cleanup.`,
        }),
      );
    }
    if (managed.detached) return err(unknownFridaSession(operation, sessionId));
    return ok(managed);
  }

  unloadScript(
    sessionId: string,
    scriptId: string,
    signal?: AbortSignal,
  ): Promise<Result<null, AnalysisError>> {
    return this.#withOperation(
      "unload_frida_script",
      () =>
        this.#withSessionLock(sessionId, () =>
          signal?.aborted
            ? Promise.resolve(
                err(cancelledOperation("unload_frida_script", signal)),
              )
            : this.#unloadScript(sessionId, scriptId),
        ),
      signal,
    );
  }

  async #unloadScript(
    sessionId: string,
    scriptId: string,
  ): Promise<Result<null, AnalysisError>> {
    const managed = this.#sessions.get(sessionId);
    const entry = managed?.scripts.get(scriptId);
    if (managed === undefined)
      return err(unknownFridaSession("unload_frida_script", sessionId));
    if (entry === undefined)
      return err(unknownFridaScript("unload_frida_script", scriptId));
    const cleanupReason = await this.#releaseScript(managed, entry);
    if (cleanupReason === undefined) return ok(null);
    return err(
      this.#retainCleanupFailure(
        entry,
        providerError(
          "unload_frida_script",
          new Error(cleanupReason),
          managed.remote,
          cleanupReason,
        ),
      ),
    );
  }

  async #releaseScript(
    managed: ManagedSession,
    entry: ManagedScript,
    parentSessionReleased = false,
  ): Promise<string | undefined> {
    if (parentSessionReleased || entry.script.isDestroyed)
      entry.state = "released";
    if (entry.state !== "released") {
      entry.state = "cleanup-pending";
      try {
        await entry.script.unload();
        entry.state = "released";
      } catch (cause: unknown) {
        if (entry.script.isDestroyed) entry.state = "released";
        else return sanitizeError(cause, managed.remote);
      }
    }
    try {
      entry.script.message.disconnect(entry.onMessage);
    } catch (cause: unknown) {
      return sanitizeError(cause, managed.remote);
    }
    managed.scripts.delete(entry.id);
    managed.scriptCaptures.delete(entry.id);
    await this.#resolveCleanupFailures(entry);
    return undefined;
  }

  status(sessionId: string): FridaSessionStatus | undefined {
    const managed = this.#sessions.get(sessionId);
    if (managed === undefined) return undefined;
    return {
      ...sessionObservation(managed),
      targetResumeObserved: managed.targetResumeObserved,
      scripts: [...managed.scripts.values()].map(({ id, name }) => ({
        scriptId: id,
        name,
      })),
      messages: managed.messages
        .toArray()
        .map(({ observation }) => observation),
      messagesTruncated: managed.messagesTruncated,
    };
  }

  closeSession(
    sessionId: string,
  ): Promise<
    Result<{ readonly targetResumeObserved: boolean }, AnalysisError>
  > {
    const pending = this.#sessionClosures.get(sessionId);
    if (pending !== undefined) return pending;
    const closing = this.#withSessionLock(sessionId, () =>
      this.#closeSession(sessionId),
    );
    this.#sessionClosures.set(sessionId, closing);
    const clear = () => {
      if (this.#sessionClosures.get(sessionId) === closing)
        this.#sessionClosures.delete(sessionId);
    };
    void closing.then(clear, clear);
    return closing;
  }

  async #closeSession(
    sessionId: string,
  ): Promise<
    Result<{ readonly targetResumeObserved: boolean }, AnalysisError>
  > {
    const managed = this.#sessions.get(sessionId);
    if (managed === undefined)
      return err(unknownFridaSession("close_frida_session", sessionId));
    managed.cleanupStarted = true;
    const scriptFailures = new Map<string, string>();
    const cleanupFailures: string[] = [];
    managed.detached ||= managed.session.isDetached();
    let parentSessionReleased = managed.detached;
    const shouldResumePausedSpawn =
      managed.mode === "spawn" &&
      ((!parentSessionReleased && !managed.targetResumeObserved) ||
        managed.resumeAfterDetachPending);
    let targetResumeObserved = managed.targetResumeObserved;
    for (const entry of [...managed.scripts.values()]) {
      const failure = await this.#releaseScript(
        managed,
        entry,
        parentSessionReleased,
      );
      if (failure !== undefined) scriptFailures.set(entry.id, failure);
    }
    try {
      if (!managed.session.isDetached()) await managed.session.detach();
      managed.detached = true;
      parentSessionReleased = true;
    } catch (cause: unknown) {
      cleanupFailures.push(
        `Unable to detach Frida session: ${sanitizeError(cause, managed.remote)}`,
      );
      managed.detached ||= managed.session.isDetached();
      parentSessionReleased = managed.detached;
    }
    if (parentSessionReleased) {
      for (const entry of [...managed.scripts.values()]) {
        const failure = await this.#releaseScript(managed, entry, true);
        if (failure === undefined) scriptFailures.delete(entry.id);
        else scriptFailures.set(entry.id, failure);
      }
    }
    if (shouldResumePausedSpawn && managed.scripts.size === 0) {
      try {
        await managed.device.resume(managed.pid);
        managed.targetResumeObserved = true;
        managed.resumeAfterDetachPending = false;
        targetResumeObserved = true;
      } catch (cause: unknown) {
        managed.resumeAfterDetachPending = true;
        cleanupFailures.push(
          `Unable to resume spawned target: ${sanitizeError(cause, managed.remote)}`,
        );
      }
    }
    const failures = [...scriptFailures.values(), ...cleanupFailures];
    if (
      managed.remote !== undefined &&
      (managed.remoteReferenceHeld || managed.remoteRemovalPending) &&
      parentSessionReleased &&
      managed.scripts.size === 0 &&
      !managed.resumeAfterDetachPending
    ) {
      const failure = await this.#releaseManagedRemote(managed);
      if (failure !== undefined) failures.push(failure);
    }
    if (failures.length > 0)
      return err(
        this.#retainCleanupFailure(
          managed,
          new AnalysisCapabilityUnavailableError(
            "frida",
            "close_frida_session",
            failures[0] ?? "Frida session cleanup failed",
            {
              cleanup: {
                reason: failures.join("; "),
                resources: [sessionId],
              },
            },
          ),
        ),
      );
    this.#sessions.delete(sessionId);
    await this.#resolveCleanupFailures(managed);
    return ok({ targetResumeObserved });
  }

  closeAll(): Promise<void> {
    this.#closing = true;
    this.#closeAllPromise ??= this.#closeAll().catch((cause: unknown) => {
      this.#closeAllPromise = undefined;
      throw cause;
    });
    return this.#closeAllPromise;
  }

  async #closeAll(): Promise<void> {
    await Promise.allSettled(this.#operations);
    const startupFailures = await Promise.all(
      [...this.#pendingStartups].map(async (pending) => {
        const reasons = await this.#cleanupStartup(pending);
        return reasons.length === 0
          ? []
          : [
              this.#retainCleanupFailure(
                pending,
                new ProviderCleanupError(
                  "frida",
                  [pending.id],
                  {
                    reason: reasons.join("; "),
                  },
                  { operation: "frida_cleanup" },
                ),
              ),
            ];
      }),
    );
    const results = await Promise.all(
      [...this.#sessions.keys()].map((sessionId) =>
        this.closeSession(sessionId),
      ),
    );
    const failures = [
      ...startupFailures.flat(),
      ...results.flatMap((result) => (result.ok ? [] : [result.error])),
    ];
    const manager = this.#deviceManager;
    if (manager !== undefined) {
      for (const [address, reference] of this.#remoteDevices) {
        if (reference.references !== 0) continue;
        try {
          await this.#releaseRemote(manager, address);
        } catch (cause) {
          failures.push(
            this.#retainCleanupFailure(
              reference,
              new ProviderCleanupError(
                "frida",
                [address],
                {
                  reason:
                    "Unable to close remote Frida connection during shutdown",
                },
                { cause, operation: "frida_cleanup" },
              ),
            ),
          );
        }
      }
    }
    if (failures.length > 0)
      throw providerCleanupErrorFromFailures(
        "frida",
        failures,
        "Frida session cleanup was incomplete",
        {
          operation: "frida_cleanup",
          message: "Frida session cleanup was incomplete",
        },
      );
  }

  #cleanupStartup(pending: PendingStartupCleanup): Promise<readonly string[]> {
    return this.#withSessionLock(pending.id, async () => {
      if (!this.#pendingStartups.has(pending)) return [];
      if (pending.session !== undefined) {
        try {
          if (!pending.session.isDetached()) await pending.session.detach();
          pending.session = undefined;
        } catch (cause: unknown) {
          return [
            `Unable to detach Frida session: ${sanitizeError(cause, pending.remote)}`,
          ];
        }
      }
      if (pending.spawnedPid !== undefined) {
        try {
          await pending.device.resume(pending.spawnedPid);
          pending.spawnedPid = undefined;
        } catch (cause: unknown) {
          return [
            `Unable to resume spawned target: ${sanitizeError(cause, pending.remote)}`,
          ];
        }
      }
      const remoteFailure = await this.#releaseManagedRemote(pending);
      if (remoteFailure !== undefined) return [remoteFailure];
      this.#pendingStartups.delete(pending);
      await this.#resolveCleanupFailures(pending);
      return [];
    });
  }

  #retainCleanupFailure<Failure extends AnalysisError>(
    owner: { readonly id: string },
    failure: Failure,
  ): Failure {
    const lease = this.#cleanupLease(owner);
    failure.bindCleanupResourceOwner(lease);
    lease.bindCleanupError(failure);
    return failure;
  }

  #cleanupLease(owner: { readonly id: string }): AnalysisCleanupLease {
    let lease = this.#cleanupLeases.get(owner);
    if (lease === undefined) {
      // The manager confirms native release before settling this private lease;
      // its callback must not re-enter the session or remote cleanup lock.
      lease = new AnalysisCleanupLease(async () => {}, [owner.id]);
      this.#cleanupLeases.set(owner, lease);
    }
    return lease;
  }

  async #resolveCleanupFailures(owner: { readonly id: string }): Promise<void> {
    await this.#cleanupLease(owner).release();
  }

  async #releaseManagedRemote(
    managed: ManagedRemoteConnection,
  ): Promise<string | undefined> {
    if (
      managed.remote === undefined ||
      (!managed.remoteReferenceHeld && !managed.remoteRemovalPending)
    )
      return undefined;
    const releaseReference = managed.remoteReferenceHeld;
    managed.remoteReferenceHeld = false;
    try {
      await this.#releaseRemote(
        managed.deviceManager,
        managed.remote.address,
        releaseReference,
      );
      managed.remoteRemovalPending = false;
      return undefined;
    } catch (cause: unknown) {
      managed.remoteRemovalPending = true;
      return `Unable to close remote Frida connection: ${sanitizeError(cause, managed.remote)}`;
    }
  }

  #withOperation<Value>(
    name: string,
    operation: () => Promise<Result<Value, AnalysisError>>,
    signal?: AbortSignal,
  ): Promise<Result<Value, AnalysisError>> {
    if (this.#closing)
      return Promise.resolve(
        err(
          new AnalysisCapabilityUnavailableError(
            "frida",
            name,
            "Frida instrumentation is shutting down.",
          ),
        ),
      );
    let start = () => {};
    const pending = new Promise<Result<Value, AnalysisError>>(
      (resolve, reject) => {
        start = () => {
          try {
            resolve(
              signal?.aborted
                ? err(cancelledOperation(name, signal))
                : operation(),
            );
          } catch (cause: unknown) {
            reject(cause);
          }
        };
      },
    );
    this.#operations.add(pending);
    const release = () => {
      this.#operations.delete(pending);
    };
    void pending.then(release, release);
    start();
    return pending;
  }

  async #withSessionLock<Value>(
    sessionId: string,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const previous = this.#sessionQueues.get(sessionId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#sessionQueues.set(sessionId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#sessionQueues.get(sessionId) === tail)
        this.#sessionQueues.delete(sessionId);
    }
  }

  #recordMessage(
    managed: ManagedSession,
    scriptId: string,
    message: FridaMessage,
    data: Buffer | null,
  ): void {
    const built = buildCapturedObservation(managed, scriptId, message, data);
    if (built.binaryTruncated) markMessageTruncated(managed, scriptId);
    const { observation, charge } = built;
    if (charge > managed.captureLimits.session_bytes) {
      markMessageTruncated(managed, scriptId);
      return;
    }
    while (
      managed.messages.size > 0 &&
      managed.capturedBytes + charge > managed.captureLimits.session_bytes
    ) {
      const removed = managed.messages.shift();
      if (removed !== undefined) {
        managed.capturedBytes -= removed.charge;
        // Both queues are in arrival order, so the globally oldest message is
        // also the oldest one retained for its script.
        const scriptMessages = managed.scriptCaptures.get(
          removed.scriptId,
        )?.messages;
        if (scriptMessages?.peek() === removed.observation)
          scriptMessages.shift();
        markMessageTruncated(managed, removed.scriptId);
      }
    }
    managed.messages.push({ observation, scriptId, charge });
    managed.scriptCaptures.get(scriptId)?.messages.push(observation);
    managed.capturedBytes += charge;
  }

  async #getDeviceManager(): Promise<DeviceManager> {
    if (this.#deviceManager !== undefined) return this.#deviceManager;
    if (this.#deviceManagerLoading !== undefined)
      return this.#deviceManagerLoading;
    const loading = Promise.resolve().then(this.#deviceManagerLoader);
    this.#deviceManagerLoading = loading;
    try {
      this.#deviceManager = await loading;
      if (this.#availabilityFailure?.providerId === "frida")
        this.#availabilityFailure = undefined;
      return this.#deviceManager;
    } catch (cause: unknown) {
      this.#availabilityFailure = {
        providerId: "frida",
        reason: boundedRedactedString(errorMessage(cause), 4096, []).value,
      };
      throw cause;
    } finally {
      if (this.#deviceManagerLoading === loading)
        this.#deviceManagerLoading = undefined;
    }
  }

  async #selectDevice(
    manager: DeviceManager,
    selector: FridaDeviceSelector,
  ): Promise<Device> {
    if (selector.remote !== undefined)
      return this.#retainRemote(manager, selector.remote);
    try {
      return await manager.getDeviceById(
        selector.deviceId ?? "local",
        DEVICE_LOOKUP_TIMEOUT_MS,
      );
    } catch (cause: unknown) {
      if (
        cause instanceof AnalysisCancelledError ||
        cause instanceof AnalysisTimeoutError
      )
        throw cause;
      if (!isFridaDeviceLookupTimeout(cause)) throw cause;
      throw new AnalysisTimeoutError(
        "frida_device_lookup",
        DEVICE_LOOKUP_TIMEOUT_MS,
        {
          cause,
          userMessage: `Frida device lookup reached its ${String(DEVICE_LOOKUP_TIMEOUT_MS)} ms deadline (deadlineExpired). This release has no runtime override.`,
          remediationAction: `The ${String(DEVICE_LOOKUP_TIMEOUT_MS)} ms Frida device lookup has no runtime override. Confirm the selected device is attached, then retry. Another REA timeout does not raise this lookup.`,
        },
      );
    }
  }

  async #retainRemote(
    manager: DeviceManager,
    remote: FridaRemoteConnection,
  ): Promise<Device> {
    return this.#withRemoteLock(remote.address, async () => {
      const optionsDigest = sha256Hex(JSON.stringify(remoteOptions(remote)));
      let reference = this.#remoteDevices.get(remote.address);
      if (reference !== undefined) {
        if (reference.optionsDigest !== optionsDigest)
          throw new AnalysisInputError("frida_remote_connection", undefined, [
            {
              path: ["remote"],
              reason: "invalid_value",
              message:
                "This endpoint is already retained with different connection options. Reuse the existing options or close its sessions before changing them.",
            },
          ]);
        reference.references += 1;
      } else {
        const device = manager.addRemoteDevice(
          remote.address,
          remoteOptions(remote),
        );
        reference = {
          id: remote.address,
          references: 1,
          optionsDigest,
          device,
        };
        this.#remoteDevices.set(remote.address, reference);
      }
      try {
        return await reference.device;
      } catch (cause: unknown) {
        reference.references -= 1;
        if (reference.references === 0)
          this.#remoteDevices.delete(remote.address);
        throw cause;
      }
    });
  }

  async #releaseRemote(
    manager: DeviceManager,
    address: string,
    releaseReference = true,
  ): Promise<void> {
    return this.#withRemoteLock(address, async () => {
      const reference = this.#remoteDevices.get(address);
      if (reference === undefined) return;
      if (releaseReference)
        reference.references = Math.max(0, reference.references - 1);
      if (reference.references > 0) return;
      try {
        await reference.device;
      } catch {
        this.#remoteDevices.delete(address);
        return;
      }
      await manager.removeRemoteDevice(address);
      await this.#resolveCleanupFailures(reference);
      if (this.#remoteDevices.get(address) === reference)
        this.#remoteDevices.delete(address);
    });
  }

  async #withRemoteLock<Value>(
    address: string,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const previous = this.#remoteQueues.get(address) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#remoteQueues.set(address, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#remoteQueues.get(address) === tail)
        this.#remoteQueues.delete(address);
    }
  }
}

const FIELD_PREFIX_BYTES = {
  base: Buffer.byteLength('{"script_id":}'),
  type: Buffer.byteLength(',"type":'),
  typeTruncated: Buffer.byteLength(',"type_truncated":true'),
  payload: Buffer.byteLength(',"payload":'),
  payloadTruncated: Buffer.byteLength(',"payload_truncated":true'),
  payloadLimit: Buffer.byteLength(',"payload_capture_limit":'),
  description: Buffer.byteLength(',"description":'),
  descriptionTruncated: Buffer.byteLength(',"description_truncated":true'),
  stack: Buffer.byteLength(',"stack":'),
  stackTruncated: Buffer.byteLength(',"stack_truncated":true'),
  fileName: Buffer.byteLength(',"file_name":'),
  fileNameTruncated: Buffer.byteLength(',"file_name_truncated":true'),
  lineNumber: Buffer.byteLength(',"line_number":'),
  columnNumber: Buffer.byteLength(',"column_number":'),
  dataRedacted: Buffer.byteLength(',"data_redacted":true'),
  dataTruncatedPrefix: Buffer.byteLength(
    ',"data_truncated":true,"data_bytes":',
  ),
  dataTruncatedSuffix: Buffer.byteLength(
    ',"data_capture_limit":"session_bytes"',
  ),
  dataBase64: Buffer.byteLength(',"data_base64":'),
} as const;

const PAYLOAD_UNAVAILABLE_BYTES = Buffer.byteLength(
  '{"payload_unavailable":true}',
);

const remoteSecrets = (remote?: FridaRemoteConnection): readonly string[] => {
  const secrets: string[] = [];
  if (remote?.token !== undefined && remote.token.length > 0)
    secrets.push(remote.token);
  if (remote?.certificate !== undefined && remote.certificate.length > 0)
    secrets.push(remote.certificate);
  return secrets;
};

const captureBoundedPayload = (
  payload: unknown,
  limits: FridaCapturePolicy,
  secrets: readonly string[],
): BoundedJson | undefined => {
  if (payload === undefined) return undefined;
  try {
    return boundedJsonValue(
      payload,
      Math.max(0, limits.session_bytes - MAX_MESSAGE_METADATA_BYTES),
      secrets,
      limits,
    );
  } catch {
    return {
      value: { payload_unavailable: true },
      truncated: true,
      bytes: PAYLOAD_UNAVAILABLE_BYTES,
      limit: "unrepresentable",
    };
  }
};

const captureBinaryData = (
  data: Buffer | null,
  payloadBytes: number,
  limits: FridaCapturePolicy,
  secrets: readonly string[],
): {
  readonly fields: Record<string, JsonValue>;
  readonly bytes: number;
  readonly truncated: boolean;
} => {
  if (data === null) return { fields: {}, bytes: 0, truncated: false };
  const remainingMessageBytes = Math.max(
    0,
    limits.session_bytes - MAX_MESSAGE_METADATA_BYTES - payloadBytes - 4096,
  );
  const messageBinaryLimit = Math.floor((remainingMessageBytes * 3) / 4);
  if (secrets.some((secret) => data.includes(secret, 0, "utf8"))) {
    return {
      fields: { data_redacted: true },
      bytes: FIELD_PREFIX_BYTES.dataRedacted,
      truncated: false,
    };
  }
  if (data.byteLength > messageBinaryLimit) {
    return {
      fields: {
        data_truncated: true,
        data_bytes: data.byteLength,
        data_capture_limit: "session_bytes",
      },
      bytes:
        FIELD_PREFIX_BYTES.dataTruncatedPrefix +
        String(data.byteLength).length +
        FIELD_PREFIX_BYTES.dataTruncatedSuffix,
      truncated: true,
    };
  }
  const encoded = data.toString("base64");
  return {
    fields: { data_base64: encoded },
    bytes: FIELD_PREFIX_BYTES.dataBase64 + 2 + encoded.length,
    truncated: false,
  };
};

const REDACTED_MARKER = "[redacted]";
const REDACTED_BODY_BYTES = 10;

const CONTROL_CHAR_JSON_BYTES = (unit: number): number =>
  unit === 0x08 ||
  unit === 0x09 ||
  unit === 0x0a ||
  unit === 0x0c ||
  unit === 0x0d
    ? 2
    : 6;

const scanBoundedJsonBody = (
  input: string,
  start: number,
  end: number,
  remainingBytes: number,
): { readonly cursor: number; readonly bytes: number } => {
  let cursor = start;
  let bytes = 0;
  while (cursor < end) {
    const unit = input.charCodeAt(cursor);
    let charBytes: number;
    let step = 1;
    if (unit >= 0x20 && unit < 0x80) {
      charBytes = unit === 0x22 || unit === 0x5c ? 2 : 1;
    } else if (unit < 0x20) {
      charBytes = CONTROL_CHAR_JSON_BYTES(unit);
    } else if (unit < 0x800) {
      charBytes = 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = input.charCodeAt(cursor + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        charBytes = 4;
        step = 2;
      } else {
        charBytes = 6;
      }
    } else {
      charBytes = unit >= 0xdc00 && unit <= 0xdfff ? 6 : 3;
    }
    if (cursor + step > end || bytes + charBytes > remainingBytes) break;
    bytes += charBytes;
    cursor += step;
  }
  return { cursor, bytes };
};

const isSafeNonNegativeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const assignTextField = (
  target: Record<string, JsonValue>,
  key: string,
  field: BoundedRedactedText | undefined,
  prefixBytes: number,
  truncatedBytes: number,
): number => {
  if (field === undefined) return 0;
  target[key] = field.value;
  if (!field.truncated) return prefixBytes + field.bytes;
  target[`${key}_truncated`] = true;
  return prefixBytes + field.bytes + truncatedBytes;
};

const assignPayloadField = (
  target: Record<string, JsonValue>,
  payload: BoundedJson | undefined,
): number => {
  if (payload === undefined) return 0;
  target.payload = payload.value;
  let bytes = FIELD_PREFIX_BYTES.payload + payload.bytes;
  if (!payload.truncated) return bytes;
  target.payload_truncated = true;
  bytes += FIELD_PREFIX_BYTES.payloadTruncated;
  if (payload.limit !== undefined) {
    target.payload_capture_limit = payload.limit;
    bytes += FIELD_PREFIX_BYTES.payloadLimit + 2 + payload.limit.length;
  }
  return bytes;
};

const buildCapturedObservation = (
  managed: ManagedSession,
  scriptId: string,
  message: FridaMessage,
  data: Buffer | null,
): {
  readonly observation: JsonValue;
  readonly charge: number;
  readonly binaryTruncated: boolean;
} => {
  const limits = managed.captureLimits;
  const secrets = managed.secrets;
  const payload = captureBoundedPayload(message.payload, limits, secrets);
  const binary = captureBinaryData(data, payload?.bytes ?? 0, limits, secrets);
  const type = boundedRedactedString(
    message.type,
    limits.message_type_bytes,
    secrets,
  );
  const description =
    message.description === undefined
      ? undefined
      : boundedRedactedString(
          message.description,
          limits.message_text_bytes,
          secrets,
        );
  const stack =
    message.stack === undefined
      ? undefined
      : boundedRedactedString(
          message.stack,
          limits.message_text_bytes,
          secrets,
        );
  const fileName =
    message.fileName === undefined
      ? undefined
      : boundedRedactedString(
          message.fileName,
          limits.message_text_bytes,
          secrets,
        );
  const observation: Record<string, JsonValue> = {
    script_id: scriptId,
    type: type.value,
    ...(type.truncated ? { type_truncated: true } : {}),
  };
  let charge =
    FIELD_PREFIX_BYTES.base +
    jsonStringByteLength(scriptId) +
    FIELD_PREFIX_BYTES.type +
    type.bytes +
    (type.truncated ? FIELD_PREFIX_BYTES.typeTruncated : 0);
  charge += assignPayloadField(observation, payload);
  charge += assignTextField(
    observation,
    "description",
    description,
    FIELD_PREFIX_BYTES.description,
    FIELD_PREFIX_BYTES.descriptionTruncated,
  );
  charge += assignTextField(
    observation,
    "stack",
    stack,
    FIELD_PREFIX_BYTES.stack,
    FIELD_PREFIX_BYTES.stackTruncated,
  );
  charge += assignTextField(
    observation,
    "file_name",
    fileName,
    FIELD_PREFIX_BYTES.fileName,
    FIELD_PREFIX_BYTES.fileNameTruncated,
  );
  if (isSafeNonNegativeInt(message.lineNumber)) {
    observation.line_number = message.lineNumber;
    charge += FIELD_PREFIX_BYTES.lineNumber + String(message.lineNumber).length;
  }
  if (isSafeNonNegativeInt(message.columnNumber)) {
    observation.column_number = message.columnNumber;
    charge +=
      FIELD_PREFIX_BYTES.columnNumber + String(message.columnNumber).length;
  }
  Object.assign(observation, binary.fields);
  return {
    observation,
    charge: charge + binary.bytes,
    binaryTruncated: binary.truncated,
  };
};

type BoundedRedactedText = {
  readonly value: string;
  readonly truncated: boolean;
  readonly bytes: number;
};

const boundedRedactedString = (
  input: string,
  maximumBytes: number,
  secrets: readonly string[],
): BoundedRedactedText => {
  if (secrets.length === 0 || !explicitValuesOccurIn(input, secrets)) {
    if (input.length * 6 <= maximumBytes)
      return {
        value: input,
        truncated: false,
        bytes: jsonStringByteLength(input),
      };
    const fit = scanBoundedJsonBody(input, 0, input.length, maximumBytes);
    return fit.cursor === input.length
      ? { value: input, truncated: false, bytes: fit.bytes + 2 }
      : {
          value: input.slice(0, fit.cursor),
          truncated: true,
          bytes: fit.bytes + 2,
        };
  }
  const chunks: string[] = [];
  let outputBytes = 0;
  let cursor = 0;
  for (const span of explicitValueSpans(input, secrets)) {
    const kept = scanBoundedJsonBody(
      input,
      cursor,
      span.start,
      maximumBytes - outputBytes,
    );
    chunks.push(input.slice(cursor, kept.cursor));
    outputBytes += kept.bytes;
    cursor = kept.cursor;
    if (
      cursor !== span.start ||
      outputBytes + REDACTED_BODY_BYTES > maximumBytes
    )
      return {
        value: chunks.join(""),
        truncated: true,
        bytes: outputBytes + 2,
      };
    chunks.push(REDACTED_MARKER);
    outputBytes += REDACTED_BODY_BYTES;
    cursor = span.end;
  }
  const tail = scanBoundedJsonBody(
    input,
    cursor,
    input.length,
    maximumBytes - outputBytes,
  );
  chunks.push(input.slice(cursor, tail.cursor));
  outputBytes += tail.bytes;
  return {
    value: chunks.join(""),
    truncated: tail.cursor !== input.length,
    bytes: outputBytes + 2,
  };
};

type BoundedJson = {
  readonly value: JsonValue;
  readonly truncated: boolean;
  readonly bytes: number;
  readonly limit?: FridaOwnedCaptureLimit;
};

const clipped = (limit: FridaOwnedCaptureLimit): BoundedJson => ({
  value: null,
  truncated: true,
  bytes: 4,
  limit,
});

const boundedJsonArray = (
  value: readonly unknown[],
  budget: number,
  depth: number,
  visit: (value: unknown, budget: number, depth: number) => BoundedJson,
): BoundedJson => {
  const output: JsonValue[] = [];
  let usedBytes = 2;
  let limit: FridaOwnedCaptureLimit | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const separatorBytes = output.length === 0 ? 0 : 1;
    const remaining = budget - usedBytes - separatorBytes - 1;
    if (remaining < 8) {
      limit ??= "payload_bytes";
      break;
    }
    const item = visit(value[index] ?? null, remaining, depth + 1);
    if (item.bytes > remaining) {
      limit ??= "payload_bytes";
      break;
    }
    output.push(item.value);
    usedBytes += separatorBytes + item.bytes;
    if (item.truncated) {
      limit ??= item.limit;
      break;
    }
  }
  if (output.length < value.length) limit ??= "payload_bytes";
  return limit === undefined
    ? { value: output, truncated: false, bytes: usedBytes }
    : { value: output, truncated: true, bytes: usedBytes, limit };
};

const boundedJsonObject = (
  value: object,
  budget: number,
  depth: number,
  context: {
    readonly secrets: readonly string[];
    readonly visit: (
      value: unknown,
      budget: number,
      depth: number,
    ) => BoundedJson;
  },
): BoundedJson => {
  const output: Record<string, JsonValue> = {};
  let usedBytes = 2;
  let entries = 0;
  let limit: FridaOwnedCaptureLimit | undefined;
  for (const rawKey in value) {
    if (!Object.hasOwn(value, rawKey)) continue;
    const separatorBytes = entries === 0 ? 0 : 1;
    const keyLimit = Math.max(0, budget - usedBytes - separatorBytes - 10);
    const boundedKey = boundedRedactedString(rawKey, keyLimit, context.secrets);
    if (boundedKey.truncated) {
      limit ??= "payload_bytes";
      break;
    }
    const key = boundedKey.value;
    // Redaction can collapse source names; never replace a retained fact.
    if (Object.hasOwn(output, key)) {
      limit ??= "unrepresentable";
      break;
    }
    const keyBytes = boundedKey.bytes + 1;
    const remaining = budget - usedBytes - separatorBytes - keyBytes - 1;
    if (remaining < 8) {
      limit ??= "payload_bytes";
      break;
    }
    const entry = context.visit(
      Reflect.get(value, rawKey),
      remaining,
      depth + 1,
    );
    if (entry.bytes > remaining) {
      limit ??= "payload_bytes";
      break;
    }
    Object.defineProperty(output, key, {
      value: entry.value,
      configurable: true,
      enumerable: true,
      writable: true,
    });
    entries += 1;
    usedBytes += separatorBytes + keyBytes + entry.bytes;
    if (entry.truncated) {
      limit ??= entry.limit;
      break;
    }
  }
  return limit === undefined
    ? { value: output, truncated: false, bytes: usedBytes }
    : { value: output, truncated: true, bytes: usedBytes, limit };
};

const boundedJsonValue = (
  input: unknown,
  maximumBytes: number,
  secrets: readonly string[],
  limits: FridaCapturePolicy,
): BoundedJson => {
  const seen = new WeakSet<object>();
  let remainingNodes = limits.json_nodes;
  const visit = (
    value: unknown,
    budget: number,
    depth: number,
  ): BoundedJson => {
    remainingNodes -= 1;
    if (remainingNodes < 0) return clipped("json_nodes");
    if (depth > limits.json_depth) return clipped("json_depth");
    if (budget < 8) return clipped("payload_bytes");
    if (value === null) return { value: null, truncated: false, bytes: 4 };
    if (typeof value === "boolean")
      return { value, truncated: false, bytes: value ? 4 : 5 };
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return clipped("unrepresentable");
      return { value, truncated: false, bytes: String(value).length };
    }
    if (typeof value === "string") {
      const bounded = boundedRedactedString(
        value,
        Math.max(0, budget - 2),
        secrets,
      );
      return bounded.truncated
        ? {
            value: bounded.value,
            truncated: true,
            bytes: bounded.bytes,
            limit: "payload_bytes",
          }
        : { value: bounded.value, truncated: false, bytes: bounded.bytes };
    }
    if (typeof value !== "object") return clipped("unrepresentable");
    if (seen.has(value)) return clipped("unrepresentable");
    seen.add(value);
    try {
      return Array.isArray(value)
        ? boundedJsonArray(value, budget, depth, visit)
        : boundedJsonObject(value, budget, depth, { secrets, visit });
    } finally {
      seen.delete(value);
    }
  };
  const result = visit(input, maximumBytes, 0);
  return result.bytes > maximumBytes
    ? clipped(result.limit ?? "payload_bytes")
    : result;
};

const remoteOptions = (remote: FridaRemoteConnection): RemoteDeviceOptions => ({
  ...(remote.token === undefined ? {} : { token: remote.token }),
  ...(remote.certificate === undefined
    ? {}
    : { certificate: remote.certificate }),
  ...(remote.origin === undefined ? {} : { origin: remote.origin }),
  ...(remote.keepaliveInterval === undefined
    ? {}
    : { keepaliveInterval: remote.keepaliveInterval }),
});

// Attachment and target execution have independent native observations. A
// successful target resume cannot reattach a detached instrumentation session.
const sessionState = (
  managed: ManagedSession,
): FridaSessionObservation["state"] =>
  managed.detached
    ? "detached"
    : managed.mode === "spawn" && !managed.targetResumeObserved
      ? "paused"
      : "running";

const sessionObservation = (
  managed: ManagedSession,
): FridaSessionObservation => ({
  sessionId: managed.id,
  captureLimits: managed.captureLimits,
  deviceId: managed.device.id,
  target: managed.target,
  pid: managed.pid,
  mode: managed.mode,
  state: sessionState(managed),
});

const sanitizeError = (
  cause: unknown,
  remote?: FridaRemoteConnection,
): string =>
  boundedRedactedString(
    errorMessage(cause),
    4096,
    [remote?.token, remote?.certificate].filter(
      (secret): secret is string => secret !== undefined && secret.length > 0,
    ),
  ).value;

/**
 * Frida reports a refused ptrace seize with this prefix. Only that request
 * is recognized: the reason carries no errno, so it does not say whether the
 * host lacks ptrace support or permissions refused this target, and discovery
 * can succeed where injection is refused.
 */
const PTRACE_SEIZE_REFUSAL = /^Unable to perform ptrace seize\b/i;

/**
 * Guidance for the Frida failures whose generic "choose another target"
 * remediation would send the operator the wrong way.
 */
const providerFailureGuidance = (
  reason: string,
  remote: boolean,
): {
  readonly userMessage?: string;
  readonly remediationAction?: string;
} => {
  if (remote && reason === "Unable to connect to remote frida-server")
    return {
      remediationAction:
        "Confirm the selected Frida server is reachable and its connection options are correct, then retry.",
    };
  if (PTRACE_SEIZE_REFUSAL.test(reason))
    return {
      userMessage:
        "Frida could not start tracing the target because its ptrace seize request was refused.",
      remediationAction:
        "The operating system refused Frida's PTRACE_SEIZE request (see details.reason). Either the host does not implement it, as emulated environments such as PRoot-Distro on Android do, so no target can be injected although device and process discovery still succeed, or ptrace permissions refused this target alone. If other targets fail the same way, run REA on a host with native ptrace support, or select a Frida server running on one with the remote options. Otherwise check the ptrace permissions that apply to this target. Then retry.",
    };
  return {};
};

const providerError = (
  operation: string,
  cause: unknown,
  remote?: FridaRemoteConnection,
  cleanupReason?: string,
  selector?: FridaDeviceSelector,
): AnalysisError => {
  const secrets = [remote?.token, remote?.certificate].filter(
    (secret): secret is string => secret !== undefined && secret.length > 0,
  );
  const selection =
    selector?.remote === undefined
      ? selector?.deviceId
      : isValidFridaRemoteAddress(selector.remote.address)
        ? selector.remote.address
        : undefined;
  const selectionKey =
    selector?.remote === undefined ? "device_id" : "remote_address";
  const diagnostics = {
    ...(cause instanceof AnalysisError
      ? redactExplicitFailure(cause, secrets).diagnostics
      : {}),
    ...(selection === undefined
      ? {}
      : {
          [selectionKey]: boundedRedactedString(selection, 4096, secrets).value,
        }),
  };
  if (cause instanceof AnalysisInputError)
    return new AnalysisInputError(
      operation,
      { cause, diagnostics },
      cause.issues,
    );
  if (cause instanceof AnalysisTimeoutError)
    return new AnalysisTimeoutError(operation, cause.timeoutMs, {
      cause,
      diagnostics,
      ...(cause.userMessage === undefined
        ? {}
        : { userMessage: cause.userMessage }),
      ...(cause.remediationAction === undefined
        ? {}
        : { remediationAction: cause.remediationAction }),
      ...(cleanupReason === undefined
        ? {}
        : {
            cleanup: {
              reason: cleanupReason,
              resources: ["Frida provider operation"],
            },
          }),
    });
  if (cause instanceof AnalysisCancelledError)
    return cancelledBy(operation, carriedReason(cause.cause), {
      diagnostics,
      ...(cleanupReason === undefined
        ? {}
        : {
            cleanup: {
              reason: cleanupReason,
              resources: ["Frida provider operation"],
            },
          }),
    });
  const reason = sanitizeError(cause, remote);
  return new AnalysisCapabilityUnavailableError("frida", operation, reason, {
    cause: remote === undefined ? cause : new Error(reason),
    diagnostics,
    ...(cleanupReason !== undefined
      ? {}
      : providerFailureGuidance(reason, selector?.remote !== undefined)),
    ...(cleanupReason === undefined
      ? {}
      : {
          cleanup: {
            reason: cleanupReason,
            resources: ["Frida provider operation"],
          },
        }),
  });
};

const cancelledOperation = (
  operation: string,
  signal: AbortSignal,
): AnalysisCancelledError => cancelledBy(operation, signal);

interface CapturedMessage {
  readonly observation: JsonValue;
  readonly scriptId: string;
  /** Serialized bytes charged against the session capture budget. */
  readonly charge: number;
}

const markMessageTruncated = (
  managed: ManagedSession,
  scriptId: string,
): void => {
  managed.messagesTruncated = true;
  const capture = managed.scriptCaptures.get(scriptId);
  if (capture !== undefined) capture.truncated = true;
};
