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
import { providerCleanupErrorFromFailures } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { AnalysisCleanupLease } from "../resources/index.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  unknownFridaScript,
  unknownFridaSession,
} from "../domain/fridaInputErrors.js";
import {
  resolveFridaCapturePolicy,
  type FridaCapturePolicy,
} from "../domain/fridaCapturePolicy.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { FifoQueue } from "../kernel/FifoQueue.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import {
  boundedRedactedString,
  buildCapturedObservation,
  remoteSecrets,
} from "./FridaMessageCapture.js";

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
    // Resume waits for every script to be released. A retry may find the
    // session already detached, so record the owed resume rather than lose it.
    if (shouldResumePausedSpawn && managed.scripts.size > 0)
      managed.resumeAfterDetachPending = true;
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
