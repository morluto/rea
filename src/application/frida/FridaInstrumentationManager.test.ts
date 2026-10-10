import { describe, expect, it } from "vitest";

import type {
  Device,
  DeviceManager,
  FridaMessage,
  Process,
  Script,
  Session,
  Signal,
} from "frida";
import { FridaInstrumentationManager } from "../../frida/FridaInstrumentationManager.js";

const signal = <Handler extends (...args: never[]) => void>() => {
  let connected: Handler | undefined;
  const value: Signal<Handler> & {
    emit: (...args: Parameters<Handler>) => void;
  } = {
    connect: (handler) => {
      connected = handler;
    },
    disconnect: (handler) => {
      if (connected === handler) connected = undefined;
    },
    emit: (...args) => connected?.(...args),
  };
  return value;
};

class FakeScript implements Script {
  readonly message =
    signal<(message: FridaMessage, data: Buffer | null) => void>();
  isDestroyed = false;
  loadFailure: Error | undefined;
  unloadFailureCount = 0;
  unloadCalls = 0;

  constructor(
    readonly payload: unknown = { event: "loaded" },
    readonly beforeLoad: () => Promise<void> = async () => {},
    readonly description = "script loaded",
    readonly stack = "",
  ) {}

  async load(): Promise<void> {
    await this.beforeLoad();
    if (this.loadFailure !== undefined) throw this.loadFailure;
    this.message.emit(
      {
        type: "send",
        payload: this.payload,
        description: this.description,
        stack: this.stack,
      },
      null,
    );
  }

  async unload(): Promise<void> {
    this.unloadCalls += 1;
    if (this.unloadFailureCount > 0) {
      this.unloadFailureCount -= 1;
      throw new Error("script unload failed");
    }
    if (this.isDestroyed) throw new Error("Script is destroyed");
    this.isDestroyed = true;
  }
}

class FakeSession implements Session {
  readonly detached = signal<() => void>();
  readonly scripts: FakeScript[] = [];
  nextPayload: unknown = { event: "loaded" };
  nextDescription = "script loaded";
  nextStack = "";
  nextLoadFailure: Error | undefined;
  nextUnloadFailureCount = 0;
  detachFailureCount = 0;
  scriptLoadGate: Promise<void> | undefined;
  onScriptLoadStarted: (() => void) | undefined;
  private detachedState = false;
  readonly pid = 512;

  isDetached(): boolean {
    return this.detachedState;
  }

  async createScript(): Promise<Script> {
    const script = new FakeScript(
      this.nextPayload,
      async () => {
        this.onScriptLoadStarted?.();
        await this.scriptLoadGate;
      },
      this.nextDescription,
      this.nextStack,
    );
    script.loadFailure = this.nextLoadFailure;
    script.unloadFailureCount = this.nextUnloadFailureCount;
    this.nextPayload = { event: "loaded" };
    this.nextDescription = "script loaded";
    this.nextStack = "";
    this.nextLoadFailure = undefined;
    this.nextUnloadFailureCount = 0;
    this.scripts.push(script);
    return script;
  }

  async detach(): Promise<void> {
    if (this.detachFailureCount > 0) {
      this.detachFailureCount -= 1;
      throw new Error("session detach failed");
    }
    for (const script of this.scripts) script.isDestroyed = true;
    this.markDetached();
  }

  markDetached(): void {
    this.detachedState = true;
    this.detached.emit();
  }

  markDetachedWithoutSignal(): void {
    this.detachedState = true;
  }
}

class FakeDevice implements Device {
  readonly id = "local";
  readonly name = "Local System";
  readonly type = "local";
  readonly process = { pid: 512, name: "fixture" } satisfies Process;
  readonly session = new FakeSession();
  resumed: number[] = [];
  resumeFailureCount = 0;
  readonly spawned: string[] = [];

  async enumerateProcesses(): Promise<Process[]> {
    return [this.process];
  }

  async getProcessByPid(): Promise<Process> {
    return this.process;
  }

  async spawn(program: string): Promise<number> {
    this.spawned.push(program);
    return this.process.pid;
  }

  async resume(pid: number): Promise<void> {
    if (this.resumeFailureCount > 0) {
      this.resumeFailureCount -= 1;
      throw new Error("target resume failed");
    }
    this.resumed.push(pid);
  }

  async attach(): Promise<Session> {
    return this.session;
  }
}

class FakeDeviceManager implements DeviceManager {
  readonly device = new FakeDevice();
  removedRemote: string[] = [];
  removeRemoteFailureCount = 0;
  removeRemoteFailureMessage = "remote device removal failed";

  async enumerateDevices(): Promise<Device[]> {
    return [this.device];
  }

  async getDeviceById(): Promise<Device> {
    return this.device;
  }

  async addRemoteDevice(): Promise<Device> {
    return this.device;
  }

  async removeRemoteDevice(address: string): Promise<void> {
    if (this.removeRemoteFailureCount > 0) {
      this.removeRemoteFailureCount -= 1;
      throw new Error(this.removeRemoteFailureMessage);
    }
    this.removedRemote.push(address);
  }
}

// eslint-disable-next-line max-lines-per-function -- related manager lifecycle cases share the same focused fake provider.
describe("FridaInstrumentationManager", () => {
  it("loads instrumentation before resuming a spawned target", async () => {
    const bindings = new FakeDeviceManager();
    const manager = new FridaInstrumentationManager({
      deviceManager: bindings,
    });

    const started = await manager.startSession({
      mode: "spawn",
      deviceId: "local",
      program: "/tmp/fixture",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.state).toBe("paused");
    expect(bindings.device.resumed).toEqual([]);

    const loaded = await manager.loadScript(started.value.sessionId, {
      sourceKind: "inline",
      source: "send({ event: 'loaded' });",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.messages).toContainEqual(
      expect.objectContaining({
        type: "send",
        payload: { event: "loaded" },
      }),
    );
    expect(loaded.value.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(bindings.device.resumed).toEqual([]);

    const resumed = await manager.resumeSession(started.value.sessionId);
    expect(resumed.ok).toBe(true);
    expect(bindings.device.resumed).toEqual([512]);
    expect(manager.status(started.value.sessionId)?.state).toBe("running");
    await manager.closeAll();
    expect(bindings.device.session.isDetached()).toBe(true);
  });

  it("removes a remote device after process discovery", async () => {
    const bindings = new FakeDeviceManager();
    const manager = new FridaInstrumentationManager({
      deviceManager: bindings,
    });
    const started = await manager.startSession({
      mode: "attach",
      remote: { address: "127.0.0.1:27042", token: "secret-token" },
      pid: 512,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const listed = await manager.listProcesses({
      remote: { address: "127.0.0.1:27042", token: "secret-token" },
    });

    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.processes[0]?.pid).toBe(512);
      expect(listed.value.cleanupError).toBeNull();
    }
    expect(bindings.removedRemote).toEqual([]);
    await manager.closeSession(started.value.sessionId);
    expect(bindings.removedRemote).toEqual(["127.0.0.1:27042"]);
    await manager.closeAll();
  });

  it("preserves remote discovery facts when cleanup fails and retries cleanup", async () => {
    const bindings = new FakeDeviceManager();
    bindings.removeRemoteFailureCount = 1;
    const manager = new FridaInstrumentationManager({
      deviceManager: bindings,
    });
    const listed = await manager.listProcesses({
      remote: { address: "127.0.0.1:27042" },
    });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.processes).toEqual([
        { pid: 512, name: "fixture", identifier: null },
      ]);
      expect(listed.value.cleanupError).toContain(
        "remote device removal failed",
      );
    }
    await manager.closeAll();
    expect(bindings.removedRemote).toEqual(["127.0.0.1:27042"]);
  });

  it("does not expose remote credentials in shutdown cleanup failures", async () => {
    const token = "synthetic-close-token";
    const certificate = "synthetic-close-certificate";
    const bindings = new FakeDeviceManager();
    bindings.removeRemoteFailureCount = 2;
    bindings.removeRemoteFailureMessage = `${token} ${certificate}`;
    const manager = new FridaInstrumentationManager({
      deviceManager: bindings,
    });
    const started = await manager.startSession({
      mode: "attach",
      remote: { address: "127.0.0.1:27042", token, certificate },
      pid: 512,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    let failure = "";
    try {
      await manager.closeAll();
    } catch (cause: unknown) {
      failure =
        cause instanceof AggregateError
          ? cause.errors.map((entry: unknown) => String(entry)).join("; ")
          : String(cause);
    }
    expect(failure).not.toBe("");
    expect(failure).not.toContain(token);
    expect(failure).not.toContain(certificate);
  });

  it("unloads scripts, resumes a paused spawn, and detaches without killing it", async () => {
    const bindings = new FakeDeviceManager();
    const manager = new FridaInstrumentationManager({
      deviceManager: bindings,
    });
    const started = await manager.startSession({
      mode: "spawn",
      deviceId: "local",
      program: "/tmp/fixture",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const loaded = await manager.loadScript(started.value.sessionId, {
      sourceKind: "inline",
      source: "send('ready');",
    });
    expect(loaded.ok).toBe(true);
    const closed = await manager.closeSession(started.value.sessionId);
    expect(closed.ok).toBe(true);
    expect(bindings.device.session.scripts[0]?.isDestroyed).toBe(true);
    expect(bindings.device.resumed).toEqual([512]);
    expect(bindings.device.session.isDetached()).toBe(true);
  });

  it("retains a failed script handle until a later cleanup retry releases it", async () => {
    const bindings = new FakeDeviceManager();
    bindings.device.session.nextLoadFailure = new Error("script load failed");
    bindings.device.session.nextUnloadFailureCount = 1;
    const manager = new FridaInstrumentationManager({
      deviceManager: bindings,
    });
    const started = await manager.startSession({
      mode: "attach",
      deviceId: "local",
      pid: 512,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const loaded = await manager.loadScript(started.value.sessionId, {
      sourceKind: "inline",
      source: "send('ready');",
    });

    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.cleanupIncomplete).toBe(true);
    expect(manager.status(started.value.sessionId)?.scripts).toHaveLength(1);
    expect(bindings.device.session.scripts[0]?.unloadCalls).toBe(1);

    const closed = await manager.closeSession(started.value.sessionId);

    expect(closed.ok).toBe(true);
    expect(bindings.device.session.scripts[0]?.unloadCalls).toBe(2);
    expect(bindings.device.session.scripts[0]?.isDestroyed).toBe(true);
    expect(manager.status(started.value.sessionId)).toBeUndefined();
  });

  it("closes a session when its target already destroyed the script", async () => {
    const bindings = new FakeDeviceManager();
    const manager = new FridaInstrumentationManager({
      deviceManager: bindings,
    });
    const started = await manager.startSession({
      mode: "attach",
      deviceId: "local",
      pid: 512,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const loaded = await manager.loadScript(started.value.sessionId, {
      sourceKind: "inline",
      source: "send('ready');",
    });
    expect(loaded.ok).toBe(true);
    const script = bindings.device.session.scripts[0];
    expect(script).toBeDefined();
    if (script === undefined) return;
    script.isDestroyed = true;
    bindings.device.session.markDetached();

    const closed = await manager.closeSession(started.value.sessionId);

    expect(closed.ok).toBe(true);
    expect(script.unloadCalls).toBe(0);
    expect(manager.status(started.value.sessionId)).toBeUndefined();
  });

  it("does not resume a paused spawn after its parent session detached", async () => {
    const bindings = new FakeDeviceManager();
    const manager = new FridaInstrumentationManager({
      deviceManager: bindings,
    });
    const started = await manager.startSession({
      mode: "spawn",
      deviceId: "local",
      program: "/tmp/fixture",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    bindings.device.session.markDetachedWithoutSignal();

    const closed = await manager.closeSession(started.value.sessionId);

    expect(closed.ok).toBe(true);
    expect(bindings.device.resumed).toEqual([]);
    expect(manager.status(started.value.sessionId)).toBeUndefined();
  });

  it("uses successful parent-session detach to release a script after unload fails", async () => {
    const bindings = new FakeDeviceManager();
    const manager = new FridaInstrumentationManager({
      deviceManager: bindings,
    });
    const started = await manager.startSession({
      mode: "attach",
      deviceId: "local",
      pid: 512,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const loaded = await manager.loadScript(started.value.sessionId, {
      sourceKind: "inline",
      source: "send('ready');",
    });
    expect(loaded.ok).toBe(true);
    const script = bindings.device.session.scripts[0];
    expect(script).toBeDefined();
    if (script === undefined) return;
    script.unloadFailureCount = 1;

    const closed = await manager.closeSession(started.value.sessionId);

    expect(closed.ok).toBe(true);
    expect(script.isDestroyed).toBe(true);
    expect(manager.status(started.value.sessionId)).toBeUndefined();
  });

  it("keeps a paused spawn paused when script unload and session detach fail", async () => {
    const bindings = new FakeDeviceManager();
    const manager = new FridaInstrumentationManager({
      deviceManager: bindings,
    });
    const started = await manager.startSession({
      mode: "spawn",
      deviceId: "local",
      program: "/tmp/fixture",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const loaded = await manager.loadScript(started.value.sessionId, {
      sourceKind: "inline",
      source: "send('ready');",
    });
    expect(loaded.ok).toBe(true);
    const script = bindings.device.session.scripts[0];
    expect(script).toBeDefined();
    if (script === undefined) return;
    script.unloadFailureCount = 1;
    bindings.device.session.detachFailureCount = 1;

    const closed = await manager.closeSession(started.value.sessionId);

    expect(closed.ok).toBe(false);
    expect(bindings.device.resumed).toEqual([]);
    expect(manager.status(started.value.sessionId)?.scripts).toHaveLength(1);
  });

  it("retries resuming a spawn after detach succeeded but resume failed", async () => {
    const bindings = new FakeDeviceManager();
    const manager = new FridaInstrumentationManager({
      deviceManager: bindings,
    });
    const started = await manager.startSession({
      mode: "spawn",
      deviceId: "local",
      program: "/tmp/fixture",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const loaded = await manager.loadScript(started.value.sessionId, {
      sourceKind: "inline",
      source: "send('ready');",
    });
    expect(loaded.ok).toBe(true);
    bindings.device.resumeFailureCount = 1;

    const firstClose = await manager.closeSession(started.value.sessionId);

    expect(firstClose.ok).toBe(false);
    expect(bindings.device.session.isDetached()).toBe(true);
    expect(manager.status(started.value.sessionId)).toBeDefined();

    const retry = await manager.closeSession(started.value.sessionId);

    expect(retry.ok).toBe(true);
    expect(bindings.device.resumed).toEqual([512]);
    expect(manager.status(started.value.sessionId)).toBeUndefined();
  });

  it("keeps a remote device while a spawned target resume is pending", async () => {
    const bindings = new FakeDeviceManager();
    const manager = new FridaInstrumentationManager({
      deviceManager: bindings,
    });
    const started = await manager.startSession({
      mode: "spawn",
      remote: { address: "127.0.0.1:27042" },
      program: "/tmp/fixture",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    bindings.device.resumeFailureCount = 1;

    const firstClose = await manager.closeSession(started.value.sessionId);

    expect(firstClose.ok).toBe(false);
    expect(bindings.removedRemote).toEqual([]);

    const retry = await manager.closeSession(started.value.sessionId);

    expect(retry.ok).toBe(true);
    expect(bindings.device.resumed).toEqual([512]);
    expect(bindings.removedRemote).toEqual(["127.0.0.1:27042"]);
  });

  it("keeps a remote device while script and session cleanup are pending", async () => {
    const bindings = new FakeDeviceManager();
    const manager = new FridaInstrumentationManager({
      deviceManager: bindings,
    });
    const started = await manager.startSession({
      mode: "attach",
      remote: { address: "127.0.0.1:27042" },
      pid: 512,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const loaded = await manager.loadScript(started.value.sessionId, {
      sourceKind: "inline",
      source: "send('ready');",
    });
    expect(loaded.ok).toBe(true);
    const script = bindings.device.session.scripts[0];
    expect(script).toBeDefined();
    if (script === undefined) return;
    script.unloadFailureCount = 1;
    bindings.device.session.detachFailureCount = 1;

    const firstClose = await manager.closeSession(started.value.sessionId);

    expect(firstClose.ok).toBe(false);
    expect(bindings.removedRemote).toEqual([]);

    const retry = await manager.closeSession(started.value.sessionId);

    expect(retry.ok).toBe(true);
    expect(script.isDestroyed).toBe(true);
    expect(bindings.removedRemote).toEqual(["127.0.0.1:27042"]);
  });
});

it("serializes a final remote release against a new same-endpoint session", async () => {
  const bindings = new FakeDeviceManager();
  let enteredRemoval: (() => void) | undefined;
  const removalEntered = new Promise<void>((resolve) => {
    enteredRemoval = resolve;
  });
  let finishRemoval: (() => void) | undefined;
  const removalGate = new Promise<void>((resolve) => {
    finishRemoval = resolve;
  });
  bindings.removeRemoteDevice = async (address) => {
    enteredRemoval?.();
    await removalGate;
    bindings.removedRemote.push(address);
  };
  const manager = new FridaInstrumentationManager({
    deviceManager: bindings,
  });
  const remote = { address: "127.0.0.1:27042", token: "same-token" };
  const first = await manager.startSession({
    mode: "attach",
    remote,
    pid: 512,
  });
  expect(first.ok).toBe(true);
  if (!first.ok) return;

  const closing = manager.closeSession(first.value.sessionId);
  await removalEntered;
  let secondStarted = false;
  const secondPromise = manager
    .startSession({ mode: "attach", remote, pid: 512 })
    .then((result) => {
      secondStarted = true;
      return result;
    });
  await Promise.resolve();
  expect(secondStarted).toBe(false);
  finishRemoval?.();
  expect((await closing).ok).toBe(true);
  const second = await secondPromise;
  expect(second.ok).toBe(true);
  if (second.ok) await manager.closeSession(second.value.sessionId);
  expect(bindings.removedRemote).toEqual([
    "127.0.0.1:27042",
    "127.0.0.1:27042",
  ]);
});

it("redacts remote credentials and maps a missing optional binding", async () => {
  const secret = "synthetic-secret-token";
  const remoteManager = new FakeDeviceManager();
  remoteManager.addRemoteDevice = async () => {
    throw new Error(`authorization rejected: ${secret}`);
  };
  const remote = new FridaInstrumentationManager({
    deviceManager: remoteManager,
  });
  const failed = await remote.listProcesses({
    remote: {
      address: "wss://host/path?token=synthetic-url-token",
      token: secret,
    },
  });
  expect(failed.ok).toBe(false);
  if (!failed.ok) {
    expect(failed.error.message).not.toContain(secret);
    expect(failed.error.message).not.toContain("synthetic-url-token");
  }

  const missing = new FridaInstrumentationManager({
    deviceManagerLoader: async () => {
      throw new Error("Cannot find package 'frida'");
    },
  });
  const unavailable = await missing.listDevices();
  expect(unavailable.ok).toBe(false);
  if (!unavailable.ok)
    expect(unavailable.error.message).toContain("Cannot find package 'frida'");
});

it("redacts remote credentials echoed by a target script", async () => {
  const token = "synthetic-token-from-auth";
  const certificate = "synthetic-certificate-from-auth";
  const bindings = new FakeDeviceManager();
  bindings.device.session.nextPayload = { token, certificate };
  const manager = new FridaInstrumentationManager({ deviceManager: bindings });
  const started = await manager.startSession({
    mode: "attach",
    remote: { address: "127.0.0.1:27042", token, certificate },
    pid: 512,
  });
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const loaded = await manager.loadScript(started.value.sessionId, {
    sourceKind: "inline",
    source: "send('credential payload');",
  });
  expect(loaded.ok).toBe(true);
  if (loaded.ok) {
    const serialized = JSON.stringify(loaded.value.messages);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(certificate);
    expect(serialized).toContain("[redacted]");
  }
  await manager.closeAll();
});

it("bounds oversized Frida message metadata before retaining it", async () => {
  const bindings = new FakeDeviceManager();
  bindings.device.session.nextDescription = "d".repeat(1_000_000);
  bindings.device.session.nextStack = "s".repeat(1_000_000);
  const manager = new FridaInstrumentationManager({ deviceManager: bindings });
  const started = await manager.startSession({
    mode: "attach",
    deviceId: "local",
    pid: 512,
  });
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const loaded = await manager.loadScript(started.value.sessionId, {
    sourceKind: "inline",
    source: "send('metadata');",
  });
  expect(loaded.ok).toBe(true);
  if (loaded.ok) {
    expect(loaded.value.messagesTruncated).toBe(true);
    const message = loaded.value.messages[0];
    expect(message).toMatchObject({
      description_truncated: true,
      stack_truncated: true,
    });
    expect(JSON.stringify(message).length).toBeLessThan(100_000);
  }
  await manager.closeAll();
});

it("serializes script loading against concurrent close and unloads the loaded script", async () => {
  const bindings = new FakeDeviceManager();
  let finishScriptLoad: (() => void) | undefined;
  const scriptLoadGate = new Promise<void>((resolve) => {
    finishScriptLoad = resolve;
  });
  let markScriptLoadStarted: (() => void) | undefined;
  const scriptLoadStarted = new Promise<void>((resolve) => {
    markScriptLoadStarted = resolve;
  });
  bindings.device.session.scriptLoadGate = scriptLoadGate;
  bindings.device.session.onScriptLoadStarted = () => markScriptLoadStarted?.();
  const manager = new FridaInstrumentationManager({ deviceManager: bindings });
  const started = await manager.startSession({
    mode: "attach",
    deviceId: "local",
    pid: 512,
  });
  expect(started.ok).toBe(true);
  if (!started.ok) return;

  const loading = manager.loadScript(started.value.sessionId, {
    sourceKind: "inline",
    source: "send('loaded');",
  });
  await scriptLoadStarted;
  let closed = false;
  const closing = manager.closeSession(started.value.sessionId);
  void closing.then(() => {
    closed = true;
  });
  expect(manager.closeSession(started.value.sessionId)).toBe(closing);
  await Promise.resolve();
  expect(closed).toBe(false);
  finishScriptLoad?.();
  expect((await loading).ok).toBe(true);
  expect((await closing).ok).toBe(true);
  expect(bindings.device.session.scripts[0]?.isDestroyed).toBe(true);
  expect(bindings.device.session.isDetached()).toBe(true);
});
