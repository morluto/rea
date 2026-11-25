import { randomUUID } from "node:crypto";
import { AbortedWait, waitForAbortable } from "../process/AbortablePromise.js";
import {
  spawnOwnedProviderProcess,
  ProviderProcessSupervisor,
  type ProviderProcessHandle,
} from "../process/ProviderProcess.js";

import type { JsonValue } from "../domain/jsonValue.js";

/** A Leandec MCP tool answered with isError=true; text is its own message. */
export class LeandecToolError extends Error {
  readonly _tag = "LeandecToolError";
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(message);
  }
}

/** The MCP transport failed: process exit, malformed frame or JSON-RPC error. */
export class LeandecRpcError extends Error {
  readonly _tag = "LeandecRpcError";
  constructor(
    readonly reason: "exit" | "frame" | "rpc" | "spawn",
    message: string,
    readonly capturedOutput: string,
  ) {
    super(message);
  }
}

/** A pending call exceeded its deadline or the caller cancelled it. */
export class LeandecCallCancelled extends Error {
  readonly _tag = "LeandecCallCancelled";
  constructor(
    readonly reason: "timeout" | "aborted",
    message: string,
  ) {
    super(message);
  }
}

interface PendingCall {
  readonly resolve: (result: JsonValue) => void;
  readonly reject: (cause: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

/** Bounded stderr retained for diagnostics instead of unbounded memory growth. */
const STDERR_LIMIT = 16 * 1024;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export interface LeandecMcpClientOptions {
  readonly python: string;
  readonly server: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly defaultTimeoutMs: number;
}

/**
 * One Leandec stdio MCP session. Leandec's own MCP server owns target
 * resolution, its SQLite cache and the project lock, so this client never
 * touches Ghidra or the cache directly.
 */
export class LeandecMcpClient {
  #child: ProviderProcessHandle | undefined;
  #supervisor: ProviderProcessSupervisor | undefined;
  #launch: Promise<void> | undefined;
  readonly #owner = new AbortController();
  #fatal: LeandecRpcError | undefined;
  #closing: Promise<void> | undefined;
  readonly #pending = new Map<number, PendingCall>();
  readonly #options: LeandecMcpClientOptions;
  #nextId = 1;
  #buffer = "";
  #stderr = "";
  #exit:
    | { readonly code: number | null; readonly signal: string | null }
    | undefined;
  #closed = false;
  #handshake: Promise<void> | undefined;
  #serverVersion: string | undefined;

  constructor(options: LeandecMcpClientOptions) {
    this.#options = options;
  }

  async #start(): Promise<void> {
    const launch = await spawnOwnedProviderProcess({
      command: this.#options.python,
      arguments: [this.#options.server],
      runId: randomUUID(),
      expectedCommand: null,
      cwd: this.#options.cwd,
      hostEnvironment: {},
      env: {
        ...this.#options.environment,
        LEANDEC_GUI_AUTO: "0",
        LEANDEC_GUI_FOLLOW: "0",
      },
      stdin: "pipe",
      sweepTokenOwnedProcesses: true,
      signal: this.#owner.signal,
    });
    this.#child = launch.process;
    this.#supervisor = new ProviderProcessSupervisor(
      { ...launch, ownsProcessLifetime: true },
      {
        captureStdout: false,
        maxDiagnosticBytes: STDERR_LIMIT,
        onDiagnostic: (event) => {
          if (event.type === "error")
            this.#transportFailure("spawn", event.message);
        },
      },
    );
    const child = launch.process;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#onStdout(chunk));
    child.stdout?.on("error", (cause: Error) =>
      this.#transportFailure("frame", cause.message),
    );
    child.stdin?.on("error", (cause: Error) =>
      this.#transportFailure("rpc", cause.message),
    );
    child.stderr?.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.on("exit", (code: number | null, signal: string | null) => {
      this.#exit = { code, signal };
      this.#transportFailure(
        "exit",
        `Leandec MCP server stopped (${signal ?? String(code)})`,
      );
    });
    if (child.stdin == null || child.stdout == null)
      this.#transportFailure(
        "spawn",
        "Leandec MCP protocol streams are unavailable",
      );
    if (this.#supervisor.observedExit() !== undefined)
      this.#transportFailure(
        "exit",
        "Leandec MCP server stopped during startup",
      );
    if (this.#fatal !== undefined) throw this.#fatal;
  }

  #transportFailure(
    reason: "exit" | "frame" | "rpc" | "spawn",
    message: string,
  ): void {
    this.#fatal ??= new LeandecRpcError(reason, message, this.#stderr);
    this.#failAll(this.#fatal);
  }

  serverVersion(): string | undefined {
    return this.#serverVersion;
  }

  /** Perform the MCP handshake once; repeated callers share the same attempt. */
  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.#closed)
      throw new LeandecRpcError(
        "exit",
        "Leandec MCP session closed",
        this.#stderr,
      );
    if (signal?.aborted)
      throw new LeandecCallCancelled("aborted", "Caller cancelled the request");
    this.#handshake ??= this.#handshakeOnce();
    const result = await waitForAbortable(this.#handshake, signal);
    if (result instanceof AbortedWait)
      throw new LeandecCallCancelled("aborted", "Caller cancelled the request");
  }

  async #handshakeOnce(): Promise<void> {
    this.#launch ??= this.#start();
    await this.#launch;
    const signal = this.#owner.signal;
    const result = await this.#request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "rea-leandec", version: "1" },
      },
      {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: this.#options.defaultTimeoutMs,
      },
    );
    const reply = asRecord(result);
    const serverInfo = asRecord(reply?.serverInfo);
    if (
      reply?.protocolVersion !== "2024-11-05" ||
      asRecord(asRecord(reply.capabilities)?.tools) === undefined ||
      typeof serverInfo?.name !== "string" ||
      typeof serverInfo.version !== "string"
    )
      throw new LeandecRpcError(
        "frame",
        "Incompatible Leandec MCP handshake",
        this.#stderr,
      );
    if (typeof serverInfo?.version === "string")
      this.#serverVersion = serverInfo.version;
    this.#write({ jsonrpc: "2.0", method: "notifications/initialized" });
    if (this.#fatal !== undefined) throw this.#fatal;
  }

  /** Call one tool and return its parsed JSON payload. */
  async call(
    tool: string,
    argumentsValue: Readonly<Record<string, JsonValue>>,
    options: {
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<JsonValue> {
    await this.initialize(options.signal);
    const result = await this.#request(
      "tools/call",
      { name: tool, arguments: argumentsValue },
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs: options.timeoutMs ?? this.#options.defaultTimeoutMs,
      },
    );
    const content = asRecord(result)?.content;
    if (
      !Array.isArray(content) ||
      typeof asRecord(content[0])?.text !== "string"
    )
      throw new LeandecRpcError(
        "frame",
        `Malformed MCP reply for ${tool}`,
        this.#stderr,
      );
    const text = asRecord(content[0])?.text as string;
    if (asRecord(result)?.isError === true)
      throw new LeandecToolError(tool, text || `${tool} failed`);
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      // A few tools answer plain text such as "no background jobs".
      return text;
    }
  }

  /** Stop the server, rejecting anything still in flight. */
  close(): Promise<void> {
    this.#closed = true;
    this.#owner.abort();
    this.#failAll(
      new LeandecRpcError("exit", "Leandec MCP session closed", this.#stderr),
    );
    this.#closing ??= this.#closeOwned().catch((cause: unknown) => {
      this.#closing = undefined;
      throw cause;
    });
    return this.#closing;
  }

  async #closeOwned(): Promise<void> {
    await Promise.allSettled([this.#launch, this.#handshake]);
    if (this.#supervisor === undefined) return;
    const stopped = await this.#supervisor.stop();
    if (stopped.status === "incomplete")
      throw new LeandecRpcError("exit", stopped.reason, this.#stderr);
  }

  #cancel(id: number, method: string, reason: string): void {
    if (method === "tools/call" && this.#pending.has(id))
      this.#write({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: id, reason },
      });
  }

  #request(
    method: string,
    params: JsonValue,
    options: { readonly signal?: AbortSignal; readonly timeoutMs: number },
  ): Promise<JsonValue> {
    if (this.#fatal !== undefined) return Promise.reject(this.#fatal);
    if (this.#closed || this.#exit !== undefined)
      return Promise.reject(
        new LeandecRpcError(
          "exit",
          "Leandec MCP server is not running",
          this.#stderr,
        ),
      );
    if (options.signal?.aborted === true)
      return Promise.reject(
        new LeandecCallCancelled("aborted", "Caller cancelled the request"),
      );
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.#cancel(id, method, "Caller cancelled");
        this.#settle(id, (pending) =>
          pending.reject(
            new LeandecCallCancelled("aborted", "Caller cancelled the request"),
          ),
        );
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        this.#cancel(id, method, "Deadline exceeded");
        this.#settle(id, (pending) =>
          pending.reject(
            new LeandecCallCancelled(
              "timeout",
              `Leandec ${method} exceeded ${String(options.timeoutMs)}ms`,
            ),
          ),
        );
      }, options.timeoutMs);
      timer.unref();
      this.#pending.set(id, {
        resolve,
        reject,
        timer,
        signal: options.signal,
        onAbort: options.signal === undefined ? undefined : onAbort,
      });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  #settle(id: number, action: (pending: PendingCall) => void): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.onAbort !== undefined)
      pending.signal.removeEventListener("abort", pending.onAbort);
    action(pending);
  }

  #write(message: JsonValue): void {
    if (this.#fatal !== undefined || this.#closed) return;
    const stdin = this.#child?.stdin;
    if (stdin == null || !stdin.writable) {
      this.#transportFailure("rpc", "Leandec MCP stdin is not writable");
      return;
    }
    try {
      stdin.write(JSON.stringify(message) + "\n", (cause?: Error | null) => {
        if (cause != null) this.#transportFailure("rpc", cause.message);
      });
    } catch (cause: unknown) {
      this.#transportFailure(
        "rpc",
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }

  #onStdout(chunk: string): void {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_FRAME_BYTES) {
      this.#buffer = "";
      this.#failAll(
        new LeandecRpcError(
          "frame",
          "Leandec MCP frame exceeded its limit",
          this.#stderr,
        ),
      );
      return;
    }
    for (;;) {
      const index = this.#buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length === 0) continue;
      let message: JsonValue;
      try {
        message = JSON.parse(line) as JsonValue;
      } catch {
        this.#failAll(
          new LeandecRpcError(
            "frame",
            "Leandec MCP emitted a non-JSON line",
            line,
          ),
        );
        continue;
      }
      this.#onMessage(message);
    }
  }

  #onMessage(message: JsonValue): void {
    const record = asRecord(message);
    const id = record?.id;
    if (typeof id !== "number") return;
    const error = asRecord(record?.error);
    if (error !== undefined) {
      this.#settle(id, (pending) =>
        pending.reject(
          new LeandecRpcError(
            "rpc",
            typeof error.message === "string"
              ? error.message
              : "Leandec JSON-RPC error",
            this.#stderr,
          ),
        ),
      );
      return;
    }
    if (record?.jsonrpc !== "2.0" || record.result === undefined) {
      this.#transportFailure("frame", "Malformed JSON-RPC response");
      return;
    }
    this.#settle(id, (pending) => pending.resolve(record.result as JsonValue));
  }

  #failAll(cause: Error): void {
    for (const id of Array.from(this.#pending.keys())) {
      const pending = this.#pending.get(id);
      if (pending === undefined) continue;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (pending.signal !== undefined && pending.onAbort !== undefined)
        pending.signal.removeEventListener("abort", pending.onAbort);
      pending.reject(cause);
    }
  }
}

const asRecord = (
  value: JsonValue | undefined,
): Record<string, JsonValue> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
