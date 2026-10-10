import { createHash, randomUUID } from "node:crypto";
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
} from "../application/frida/FridaInstrumentationPort.js";
import {
  AnalysisAccessDeniedError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";

const MAX_SESSION_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE_METADATA_BYTES = 128 * 1024;
const MAX_MESSAGE_TYPE_BYTES = 4 * 1024;
const MAX_MESSAGE_TEXT_BYTES = 32 * 1024;
// Bound the in-memory object graph as well as its serialized JSON byte size.
const MAX_CAPTURE_JSON_NODES = 250_000;
const MAX_BINARY_MESSAGE_BYTES = Math.floor(
  ((MAX_SESSION_CAPTURE_BYTES - 1024 * 1024) * 3) / 4,
);
const DEVICE_LOOKUP_TIMEOUT_MS = 1_000;

export const FRIDA_PROVIDER_IDENTITY = {
  id: "frida",
  name: "Frida",
  version: null,
} as const;

interface ManagedScript {
  readonly id: string;
  readonly name: string;
  readonly script: Script;
  readonly onMessage: (message: FridaMessage, data: Buffer | null) => void;
  released: boolean;
}

interface ManagedSession {
  readonly id: string;
  readonly device: Device;
  readonly deviceManager: DeviceManager;
  readonly remote: FridaRemoteConnection | undefined;
  remoteReferenceHeld: boolean;
  readonly session: Session;
  readonly target: string;
  readonly pid: number;
  readonly mode: "attach" | "spawn";
  readonly scripts: Map<string, ManagedScript>;
  readonly messages: JsonValue[];
  state: "paused" | "running" | "detached";
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
  readonly #sessionQueues = new Map<string, Promise<void>>();
  readonly #sessionClosures = new Map<
    string,
    Promise<Result<null, AnalysisError>>
  >();
  readonly #remoteDevices = new Map<
    string,
    { references: number; optionsDigest: string; device: Promise<Device> }
  >();
  readonly #remoteQueues = new Map<string, Promise<void>>();
  readonly #deviceManagerLoader: () => Promise<DeviceManager>;
  #deviceManager: DeviceManager | undefined;

  constructor(options: FridaInstrumentationManagerOptions = {}) {
    this.#deviceManager = options.deviceManager;
    this.#deviceManagerLoader =
      options.deviceManagerLoader ??
      (async () => (await import("frida")).getDeviceManager());
  }

  async listDevices(remote?: FridaRemoteConnection): Promise<
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
      return err(
        providerError("list_frida_devices", cause, remote, cleanupError),
      );
    }
  }

  async listProcesses(selector: FridaDeviceSelector): Promise<
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
      return err(
        providerError(
          "list_frida_processes",
          cause,
          selector.remote,
          cleanupError,
        ),
      );
    }
  }

  async startSession(
    input: StartFridaSessionInput,
  ): Promise<Result<FridaSessionObservation, AnalysisError>> {
    let manager: DeviceManager | undefined;
    let device: Device | undefined;
    let remoteHeld = false;
    let spawnedPid: number | undefined;
    try {
      manager = await this.#getDeviceManager();
      device = await this.#selectDevice(manager, input);
      remoteHeld = input.remote !== undefined;
      let pid: number;
      let target: string;
      if (input.mode === "attach") {
        const process = await device.getProcessByPid(input.pid);
        pid = process.pid;
        target = `${process.name} (pid ${process.pid})`;
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
      const session = await device.attach(pid);
      const id = randomUUID();
      const managed: ManagedSession = {
        id,
        device,
        deviceManager: manager,
        remote: input.remote,
        remoteReferenceHeld: remoteHeld,
        session,
        target,
        pid,
        mode: input.mode,
        scripts: new Map(),
        messages: [],
        state: input.mode === "spawn" ? "paused" : "running",
        resumeAfterDetachPending: false,
        capturedBytes: 0,
        messagesTruncated: false,
      };
      session.detached.connect(() => {
        managed.state = "detached";
      });
      this.#sessions.set(id, managed);
      return ok(sessionObservation(managed));
    } catch (cause: unknown) {
      const cleanupFailures: string[] = [];
      if (spawnedPid !== undefined && device !== undefined) {
        try {
          await device.resume(spawnedPid);
        } catch (cleanupCause: unknown) {
          cleanupFailures.push(
            `Unable to resume spawned target: ${sanitizeError(cleanupCause, input.remote)}`,
          );
        }
      }
      if (manager !== undefined && remoteHeld && input.remote !== undefined) {
        try {
          await this.#releaseRemote(manager, input.remote.address);
        } catch (cleanupCause: unknown) {
          cleanupFailures.push(
            `Unable to close remote connection: ${sanitizeError(cleanupCause, input.remote)}`,
          );
        }
      }
      return err(
        providerError(
          "start_frida_session",
          cause,
          input.remote,
          cleanupFailures.join("; ") || undefined,
        ),
      );
    }
  }

  loadScript(
    sessionId: string,
    source: FridaScriptSource,
  ): Promise<Result<FridaScriptObservation, AnalysisError>> {
    return this.#withSessionLock(sessionId, () =>
      this.#loadScript(sessionId, source),
    );
  }

  async #loadScript(
    sessionId: string,
    source: FridaScriptSource,
  ): Promise<Result<FridaScriptObservation, AnalysisError>> {
    const managed = this.#sessions.get(sessionId);
    if (managed === undefined || managed.state === "detached")
      return err(new AnalysisInputError("load_frida_script"));

    let scriptSource: string;
    try {
      scriptSource =
        source.sourceKind === "inline"
          ? source.source
          : await readFile(source.path, "utf8");
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
          : new AnalysisInputError("load_frida_script", { cause }),
      );
    }

    const sourceSha256 = createHash("sha256")
      .update(scriptSource)
      .digest("hex");
    const scriptId = randomUUID();
    const scriptName = `rea-${scriptId}`;
    let nativeScript: Script | undefined;
    const onMessage = (message: FridaMessage, data: Buffer | null): void => {
      this.#recordMessage(managed, message, data);
    };
    try {
      nativeScript = await managed.session.createScript(scriptSource, {
        name: scriptName,
      });
      const entry: ManagedScript = {
        id: scriptId,
        name: scriptName,
        script: nativeScript,
        onMessage,
        released: false,
      };
      managed.scripts.set(scriptId, entry);
      nativeScript.message.connect(onMessage);
      await nativeScript.load();
      return ok({
        scriptId,
        sourceKind: source.sourceKind,
        sourcePath: source.sourceKind === "file" ? source.path : null,
        sourceSha256,
        messages: [...managed.messages],
        messagesTruncated: managed.messagesTruncated,
      });
    } catch (cause: unknown) {
      const entry = managed.scripts.get(scriptId);
      const cleanupReason =
        entry === undefined
          ? undefined
          : await this.#releaseScript(managed, entry);
      return err(
        providerError(
          "load_frida_script",
          cause,
          managed.remote,
          cleanupReason,
        ),
      );
    }
  }

  resumeSession(sessionId: string): Promise<Result<null, AnalysisError>> {
    return this.#withSessionLock(sessionId, () =>
      this.#resumeSession(sessionId),
    );
  }

  async #resumeSession(
    sessionId: string,
  ): Promise<Result<null, AnalysisError>> {
    const managed = this.#sessions.get(sessionId);
    if (managed === undefined || managed.state === "detached")
      return err(new AnalysisInputError("resume_frida_session"));
    if (managed.mode !== "spawn" || managed.state !== "paused")
      return err(
        new AnalysisCapabilityUnavailableError(
          "frida",
          "resume_frida_session",
          "Only a paused process spawned by this session can be resumed.",
        ),
      );
    try {
      await managed.device.resume(managed.pid);
      managed.state = "running";
      managed.resumeAfterDetachPending = false;
      return ok(null);
    } catch (cause: unknown) {
      return err(providerError("resume_frida_session", cause, managed.remote));
    }
  }

  unloadScript(
    sessionId: string,
    scriptId: string,
  ): Promise<Result<null, AnalysisError>> {
    return this.#withSessionLock(sessionId, () =>
      this.#unloadScript(sessionId, scriptId),
    );
  }

  async #unloadScript(
    sessionId: string,
    scriptId: string,
  ): Promise<Result<null, AnalysisError>> {
    const managed = this.#sessions.get(sessionId);
    const entry = managed?.scripts.get(scriptId);
    if (managed === undefined || entry === undefined)
      return err(new AnalysisInputError("unload_frida_script"));
    const cleanupReason = await this.#releaseScript(managed, entry);
    return cleanupReason === undefined
      ? ok(null)
      : err(
          providerError(
            "unload_frida_script",
            new Error(cleanupReason),
            managed.remote,
            cleanupReason,
          ),
        );
  }

  async #releaseScript(
    managed: ManagedSession,
    entry: ManagedScript,
    parentSessionReleased = false,
  ): Promise<string | undefined> {
    if (parentSessionReleased || entry.script.isDestroyed)
      entry.released = true;
    if (!entry.released) {
      try {
        await entry.script.unload();
        entry.released = true;
      } catch (cause: unknown) {
        if (entry.script.isDestroyed) entry.released = true;
        else return sanitizeError(cause, managed.remote);
      }
    }
    try {
      entry.script.message.disconnect(entry.onMessage);
    } catch (cause: unknown) {
      return sanitizeError(cause, managed.remote);
    }
    managed.scripts.delete(entry.id);
    return undefined;
  }

  status(sessionId: string): FridaSessionStatus | undefined {
    const managed = this.#sessions.get(sessionId);
    if (managed === undefined) return undefined;
    return {
      ...sessionObservation(managed),
      scripts: [...managed.scripts.values()].map(({ id, name }) => ({
        scriptId: id,
        name,
      })),
      messages: [...managed.messages],
      messagesTruncated: managed.messagesTruncated,
    };
  }

  closeSession(sessionId: string): Promise<Result<null, AnalysisError>> {
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

  async #closeSession(sessionId: string): Promise<Result<null, AnalysisError>> {
    const managed = this.#sessions.get(sessionId);
    if (managed === undefined)
      return err(new AnalysisInputError("close_frida_session"));
    const scriptFailures = new Map<string, string>();
    const cleanupFailures: string[] = [];
    let parentSessionReleased =
      managed.state === "detached" || managed.session.isDetached();
    const shouldResumePausedSpawn =
      managed.mode === "spawn" &&
      ((!parentSessionReleased && managed.state === "paused") ||
        managed.resumeAfterDetachPending);
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
      managed.state = "detached";
      parentSessionReleased = true;
    } catch (cause: unknown) {
      cleanupFailures.push(
        `Unable to detach Frida session: ${sanitizeError(cause, managed.remote)}`,
      );
      parentSessionReleased =
        managed.state === "detached" || managed.session.isDetached();
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
        managed.state = "running";
        managed.resumeAfterDetachPending = false;
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
      managed.remoteReferenceHeld &&
      parentSessionReleased &&
      managed.scripts.size === 0 &&
      !managed.resumeAfterDetachPending
    ) {
      try {
        await this.#releaseRemote(
          managed.deviceManager,
          managed.remote.address,
        );
        managed.remoteReferenceHeld = false;
      } catch (cause: unknown) {
        failures.push(
          `Unable to close remote Frida connection: ${sanitizeError(cause, managed.remote)}`,
        );
      }
    }
    if (failures.length > 0)
      return err(
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
      );
    this.#sessions.delete(sessionId);
    return ok(null);
  }

  async closeAll(): Promise<void> {
    const results = await Promise.all(
      [...this.#sessions.keys()].map((sessionId) =>
        this.closeSession(sessionId),
      ),
    );
    const failures = results.flatMap((result) =>
      result.ok ? [] : [result.error.message],
    );
    const manager = this.#deviceManager;
    if (manager !== undefined) {
      for (const [address, reference] of this.#remoteDevices) {
        if (reference.references !== 0) continue;
        try {
          await this.#releaseRemote(manager, address);
        } catch {
          failures.push(
            "Unable to close remote Frida connection during shutdown",
          );
        }
      }
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Frida session cleanup was incomplete",
      );
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
    message: FridaMessage,
    data: Buffer | null,
  ): void {
    const payload = message.payload;
    const secrets = [managed.remote?.token, managed.remote?.certificate].filter(
      (value): value is string => value !== undefined && value.length > 0,
    );
    let payloadResult:
      | {
          readonly value: JsonValue;
          readonly truncated: boolean;
          readonly bytes: number;
        }
      | undefined;
    if (payload !== undefined) {
      try {
        payloadResult = boundedJsonValue(
          payload,
          MAX_SESSION_CAPTURE_BYTES - MAX_MESSAGE_METADATA_BYTES,
          secrets,
        );
      } catch {
        payloadResult = {
          value: { payload_unavailable: true },
          truncated: true,
          bytes: Buffer.byteLength('{"payload_unavailable":true}'),
        };
      }
      if (payloadResult.truncated) managed.messagesTruncated = true;
    }
    let binaryResult: Record<string, JsonValue> = {};
    if (data !== null) {
      const payloadBytes = payloadResult?.bytes ?? 0;
      const remainingMessageBytes = Math.max(
        0,
        MAX_SESSION_CAPTURE_BYTES -
          MAX_MESSAGE_METADATA_BYTES -
          payloadBytes -
          4096,
      );
      const messageBinaryLimit = Math.min(
        MAX_BINARY_MESSAGE_BYTES,
        Math.floor((remainingMessageBytes * 3) / 4),
      );
      if (secrets.some((secret) => data.includes(secret, 0, "utf8"))) {
        binaryResult = { data_redacted: true };
      } else if (data.byteLength > messageBinaryLimit) {
        binaryResult = {
          data_truncated: true,
          data_bytes: data.byteLength,
        };
        managed.messagesTruncated = true;
      } else {
        binaryResult = { data_base64: data.toString("base64") };
      }
    }
    const type = boundedRedactedString(
      message.type,
      MAX_MESSAGE_TYPE_BYTES,
      secrets,
    );
    const description =
      message.description === undefined
        ? undefined
        : boundedRedactedString(
            message.description,
            MAX_MESSAGE_TEXT_BYTES,
            secrets,
          );
    const stack =
      message.stack === undefined
        ? undefined
        : boundedRedactedString(message.stack, MAX_MESSAGE_TEXT_BYTES, secrets);
    if (
      type.truncated ||
      description?.truncated === true ||
      stack?.truncated === true
    )
      managed.messagesTruncated = true;
    const observation: JsonValue = {
      type: type.value,
      ...(type.truncated ? { type_truncated: true } : {}),
      ...(payloadResult === undefined
        ? {}
        : {
            payload: payloadResult.value,
            ...(payloadResult.truncated ? { payload_truncated: true } : {}),
          }),
      ...(description === undefined
        ? {}
        : {
            description: description.value,
            ...(description.truncated ? { description_truncated: true } : {}),
          }),
      ...(stack === undefined
        ? {}
        : {
            stack: stack.value,
            ...(stack.truncated ? { stack_truncated: true } : {}),
          }),
      ...binaryResult,
    };
    const charge = Buffer.byteLength(JSON.stringify(observation));
    if (charge > MAX_SESSION_CAPTURE_BYTES) {
      managed.messagesTruncated = true;
      return;
    }
    while (
      managed.messages.length > 0 &&
      managed.capturedBytes + charge > MAX_SESSION_CAPTURE_BYTES
    ) {
      const removed = managed.messages.shift();
      if (removed !== undefined)
        managed.capturedBytes -= Buffer.byteLength(JSON.stringify(removed));
      managed.messagesTruncated = true;
    }
    managed.messages.push(observation);
    managed.capturedBytes += charge;
  }

  async #getDeviceManager(): Promise<DeviceManager> {
    this.#deviceManager ??= await this.#deviceManagerLoader();
    return this.#deviceManager;
  }

  async #selectDevice(
    manager: DeviceManager,
    selector: FridaDeviceSelector,
  ): Promise<Device> {
    if (selector.remote !== undefined)
      return this.#retainRemote(manager, selector.remote);
    return manager.getDeviceById(
      selector.deviceId ?? "local",
      DEVICE_LOOKUP_TIMEOUT_MS,
    );
  }

  async #retainRemote(
    manager: DeviceManager,
    remote: FridaRemoteConnection,
  ): Promise<Device> {
    return this.#withRemoteLock(remote.address, async () => {
      const optionsDigest = createHash("sha256")
        .update(JSON.stringify(remoteOptions(remote)))
        .digest("hex");
      let reference = this.#remoteDevices.get(remote.address);
      if (reference !== undefined) {
        if (reference.optionsDigest !== optionsDigest)
          throw new AnalysisInputError("frida_remote_connection");
        reference.references += 1;
      } else {
        const device = manager.addRemoteDevice(
          remote.address,
          remoteOptions(remote),
        );
        reference = { references: 1, optionsDigest, device };
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

  async #releaseRemote(manager: DeviceManager, address: string): Promise<void> {
    return this.#withRemoteLock(address, async () => {
      const reference = this.#remoteDevices.get(address);
      if (reference === undefined) return;
      reference.references = Math.max(0, reference.references - 1);
      if (reference.references > 0) return;
      try {
        await reference.device;
      } catch {
        this.#remoteDevices.delete(address);
        return;
      }
      await manager.removeRemoteDevice(address);
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

const boundedRedactedString = (
  input: string,
  maximumBytes: number,
  secrets: readonly string[],
): { readonly value: string; readonly truncated: boolean } => {
  const chunks: string[] = [];
  let outputBytes = 0;
  let cursor = 0;
  let segmentStart = 0;
  let truncated = false;
  while (cursor < input.length) {
    let nextSecretStart = input.length;
    let nextSecret: string | undefined;
    for (const secret of secrets) {
      const match = input.indexOf(secret, cursor);
      if (match !== -1 && match < nextSecretStart) {
        nextSecretStart = match;
        nextSecret = secret;
      }
    }
    if (nextSecretStart === cursor && nextSecret !== undefined) {
      const replacement = "[redacted]";
      const replacementBytes = jsonStringBytes(replacement) - 2;
      if (outputBytes + replacementBytes > maximumBytes) {
        truncated = true;
        break;
      }
      chunks.push(input.slice(segmentStart, cursor), replacement);
      outputBytes += replacementBytes;
      cursor += nextSecret.length;
      segmentStart = cursor;
      continue;
    }
    while (cursor < nextSecretStart) {
      const codePoint = input.codePointAt(cursor);
      if (codePoint === undefined) break;
      const character = String.fromCodePoint(codePoint);
      const characterBytes = jsonStringBytes(character) - 2;
      if (
        cursor + character.length > nextSecretStart ||
        outputBytes + characterBytes > maximumBytes
      ) {
        truncated = true;
        break;
      }
      outputBytes += characterBytes;
      cursor += character.length;
    }
    if (truncated) break;
  }
  chunks.push(input.slice(segmentStart, cursor));
  if (cursor < input.length) truncated = true;
  return { value: chunks.join(""), truncated };
};

const boundedJsonValue = (
  input: unknown,
  maximumBytes: number,
  secrets: readonly string[],
): {
  readonly value: JsonValue;
  readonly truncated: boolean;
  readonly bytes: number;
} => {
  const seen = new WeakSet<object>();
  let remainingNodes = MAX_CAPTURE_JSON_NODES;
  const visit = (
    value: unknown,
    budget: number,
    depth: number,
  ): { readonly value: JsonValue; readonly truncated: boolean } => {
    remainingNodes -= 1;
    if (remainingNodes < 0) return { value: null, truncated: true };
    if (depth > 64 || budget < 8) return { value: null, truncated: true };
    if (value === null) return { value: null, truncated: false };
    if (typeof value === "boolean" || typeof value === "number")
      return {
        value:
          typeof value === "number" && !Number.isFinite(value) ? null : value,
        truncated: typeof value === "number" && !Number.isFinite(value),
      };
    if (typeof value === "string") {
      const bounded = boundedRedactedString(
        value,
        Math.max(0, budget - 2),
        secrets,
      );
      return { value: bounded.value, truncated: bounded.truncated };
    }
    if (typeof value !== "object") return { value: null, truncated: true };
    if (seen.has(value)) return { value: null, truncated: true };
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const output: JsonValue[] = [];
        let usedBytes = 2;
        let truncated = false;
        for (let index = 0; index < value.length; index += 1) {
          const separatorBytes = output.length === 0 ? 0 : 1;
          const remaining = budget - usedBytes - separatorBytes - 1;
          if (remaining < 8) {
            truncated = true;
            break;
          }
          const item = visit(value[index] ?? null, remaining, depth + 1);
          const itemBytes = Buffer.byteLength(JSON.stringify(item.value));
          if (itemBytes > remaining) {
            truncated = true;
            break;
          }
          output.push(item.value);
          usedBytes += separatorBytes + itemBytes;
          truncated ||= item.truncated;
          if (item.truncated) break;
        }
        if (output.length < value.length) truncated = true;
        return { value: output, truncated };
      }
      const output: Record<string, JsonValue> = {};
      let usedBytes = 2;
      let entries = 0;
      let truncated = false;
      for (const rawKey in value) {
        if (!Object.hasOwn(value, rawKey)) continue;
        const separatorBytes = entries === 0 ? 0 : 1;
        const keyLimit = Math.max(0, budget - usedBytes - separatorBytes - 10);
        const boundedKey = boundedRedactedString(rawKey, keyLimit, secrets);
        if (boundedKey.truncated) {
          truncated = true;
          break;
        }
        const key = boundedKey.value;
        const keyBytes = jsonStringBytes(key) + 1;
        const remaining = budget - usedBytes - separatorBytes - keyBytes - 1;
        if (remaining < 8) {
          truncated = true;
          break;
        }
        const entry = visit(Reflect.get(value, rawKey), remaining, depth + 1);
        const entryBytes = Buffer.byteLength(JSON.stringify(entry.value));
        if (entryBytes > remaining) {
          truncated = true;
          break;
        }
        Object.defineProperty(output, key, {
          value: entry.value,
          configurable: true,
          enumerable: true,
          writable: true,
        });
        entries += 1;
        usedBytes += separatorBytes + keyBytes + entryBytes;
        truncated ||= entry.truncated;
        if (entry.truncated) break;
      }
      return { value: output, truncated };
    } finally {
      seen.delete(value);
    }
  };
  const result = visit(input, maximumBytes, 0);
  const bytes = Buffer.byteLength(JSON.stringify(result.value));
  return bytes > maximumBytes
    ? { value: null, truncated: true, bytes: Buffer.byteLength("null") }
    : { ...result, bytes };
};

const jsonStringBytes = (value: string): number => {
  let bytes = Buffer.byteLength(value) + 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 34 ||
      code === 92 ||
      code === 8 ||
      code === 9 ||
      code === 10 ||
      code === 12 ||
      code === 13
    )
      bytes += 1;
    else if (code < 32) bytes += 5;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      (value.charCodeAt(index + 1) < 0xdc00 ||
        value.charCodeAt(index + 1) > 0xdfff)
    )
      bytes += 3;
    else if (
      code >= 0xdc00 &&
      code <= 0xdfff &&
      (index === 0 ||
        value.charCodeAt(index - 1) < 0xd800 ||
        value.charCodeAt(index - 1) > 0xdbff)
    )
      bytes += 3;
  }
  return bytes;
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

const sessionObservation = (
  managed: ManagedSession,
): FridaSessionObservation => ({
  sessionId: managed.id,
  deviceId: managed.device.id,
  target: managed.target,
  pid: managed.pid,
  mode: managed.mode,
  state: managed.state,
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

const providerError = (
  operation: string,
  cause: unknown,
  remote?: FridaRemoteConnection,
  cleanupReason?: string,
): AnalysisError => {
  const reason = sanitizeError(cause, remote);
  return new AnalysisCapabilityUnavailableError("frida", operation, reason, {
    cause: remote === undefined ? cause : new Error(reason),
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

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
