import { randomBytes } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HopperCancelledError,
  type HopperError,
  HopperProcessError,
  HopperProtocolError,
  HopperStartError,
  HopperTimeoutError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import type { BridgeLaunch, BridgeLauncher } from "./BridgeLauncher.js";
import {
  parseResponseLine,
  responseResult,
  type JsonValue,
} from "./protocol.js";

const MAX_LINE_BYTES = 10 * 1024 * 1024;
const MAX_ABANDONED_REQUESTS = 1_024;
const SESSION_ROOT = process.platform === "darwin" ? "/tmp" : tmpdir();

export interface HopperClientOptions {
  readonly launcher: BridgeLauncher;
  readonly requestTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly onDiagnostic?: (event: HopperDiagnostic) => void;
}

export type HopperDiagnostic =
  | { readonly type: "launcher-stderr"; readonly bytes: number }
  | { readonly type: "launcher-exit"; readonly code: number | null };

export interface HopperServerInfo {
  readonly name: string;
  readonly version: string;
}

interface PendingRequest {
  readonly resolve: (result: Result<JsonValue, HopperError>) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

/** Owned client for the repository's authenticated in-Hopper bridge. */
export class HopperClient {
  readonly #options: Required<
    Pick<HopperClientOptions, "requestTimeoutMs" | "startupTimeoutMs">
  > &
    HopperClientOptions;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #abandoned = new Set<number>();
  #socket: Socket | undefined;
  #launch: BridgeLaunch | undefined;
  #directory: string | undefined;
  #token: string | undefined;
  #nextId = 1;
  #buffer = "";
  #closing = false;
  #startPromise: Promise<Result<HopperServerInfo, HopperError>> | undefined;

  constructor(options: HopperClientOptions) {
    this.#options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      startupTimeoutMs: options.startupTimeoutMs ?? 120_000,
    };
  }

  /** Launch Hopper's owned bridge and complete its health handshake. */
  start(): Promise<Result<HopperServerInfo, HopperError>> {
    this.#startPromise ??= this.#start();
    return this.#startPromise;
  }

  async #start(): Promise<Result<HopperServerInfo, HopperError>> {
    if (this.#socket !== undefined || this.#directory !== undefined) {
      return err(new HopperProtocolError("Hopper client is already started"));
    }
    try {
      this.#directory = await mkdtemp(join(SESSION_ROOT, "bbm-"));
    } catch (cause: unknown) {
      return err(new HopperStartError({ cause }));
    }
    const socketPath = join(this.#directory, "bridge.sock");
    this.#token = randomBytes(32).toString("hex");
    const launched = await this.#options.launcher.launch({
      directory: this.#directory,
      socketPath,
      token: this.#token,
    });
    if (!launched.ok) {
      await this.close();
      return launched;
    }
    this.#launch = launched.value;
    this.#attachLauncher(launched.value);
    const connected = await this.#connect(socketPath);
    if (!connected.ok) {
      await this.close();
      return connected;
    }
    const health = await this.#request(
      "health",
      {},
      {
        timeoutMs: this.#options.startupTimeoutMs,
      },
    );
    if (!health.ok) {
      await this.close();
      return health;
    }
    const parsed = parseServerInfo(health.value);
    if (!parsed.ok) await this.close();
    return parsed;
  }

  /** Invoke one declared Hopper operation through the bridge. */
  async callTool(
    name: string,
    arguments_: Readonly<Record<string, JsonValue>> = {},
    options: {
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<Result<JsonValue, HopperError>> {
    const started = await this.start();
    if (!started.ok) return started;
    return this.#request(name, arguments_, options);
  }

  /** Stop the bridge, settle outstanding requests, and remove session artifacts. */
  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    const socket = this.#socket;
    if (socket !== undefined && !socket.destroyed) {
      await this.#request("shutdown", {}, { timeoutMs: 500 }).catch(() =>
        err(new HopperProcessError(null)),
      );
    }
    this.#failAll(new HopperProcessError(null));
    socket?.destroy();
    this.#socket = undefined;
    if (this.#launch?.ownsProcessLifetime === true) {
      this.#launch.process.kill("SIGTERM");
    }
    this.#launch = undefined;
    if (this.#directory !== undefined) {
      await rm(this.#directory, { recursive: true, force: true });
      this.#directory = undefined;
    }
    this.#token = undefined;
    this.#startPromise = undefined;
    this.#closing = false;
  }

  async #connect(socketPath: string): Promise<Result<undefined, HopperError>> {
    const deadline = Date.now() + this.#options.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (this.#closing) return err(new HopperProcessError(null));
      try {
        await access(socketPath);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      const attempt = await connectOnce(socketPath);
      if (attempt.ok) {
        this.#socket = attempt.value;
        this.#attachSocket(attempt.value);
        return ok(undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return err(new HopperTimeoutError(this.#options.startupTimeoutMs));
  }

  async #request(
    method: string,
    params: JsonValue,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<Result<JsonValue, HopperError>> {
    const socket = this.#socket;
    const token = this.#token;
    if (socket === undefined || socket.destroyed || token === undefined) {
      return err(new HopperProcessError(null));
    }
    if (options.signal?.aborted === true)
      return err(new HopperCancelledError());
    const id = this.#nextId++;
    const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs;
    const response = new Promise<Result<JsonValue, HopperError>>((resolve) => {
      const onAbort =
        options.signal === undefined
          ? undefined
          : () => {
              this.#abandon(id, err(new HopperCancelledError()));
            };
      const timer = setTimeout(() => {
        this.#abandon(id, err(new HopperTimeoutError(timeoutMs)));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve,
        timer,
        signal: options.signal,
        onAbort,
      });
      options.signal?.addEventListener("abort", onAbort ?? (() => undefined), {
        once: true,
      });
    });
    socket.write(
      `${JSON.stringify({ id, token, method, params })}\n`,
      (cause) => {
        if (cause !== undefined && cause !== null)
          this.#settle(id, err(new HopperProcessError(null)));
      },
    );
    return response;
  }

  #attachSocket(socket: Socket): void {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#onData(chunk);
    });
    socket.on("error", () => {
      this.#failAll(new HopperProcessError(null));
    });
    socket.on("close", () => {
      if (!this.#closing) this.#failAll(new HopperProcessError(null));
    });
  }

  #attachLauncher(launch: BridgeLaunch): void {
    launch.process.stderr?.on("data", (chunk: Buffer) => {
      this.#options.onDiagnostic?.({
        type: "launcher-stderr",
        bytes: chunk.byteLength,
      });
    });
    launch.process.on("exit", (code) => {
      this.#options.onDiagnostic?.({ type: "launcher-exit", code });
      if (launch.ownsProcessLifetime && !this.#closing) {
        this.#failAll(new HopperProcessError(code));
      }
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer) > MAX_LINE_BYTES) {
      this.#abortProtocol("Hopper response exceeded the maximum line size");
      return;
    }
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length > 0) this.#onLine(line);
      newline = this.#buffer.indexOf("\n");
    }
  }

  #onLine(line: string): void {
    const parsed = parseResponseLine(line);
    if (!parsed.ok) {
      this.#abortProtocol(parsed.error.message, parsed.error);
      return;
    }
    if (this.#abandoned.delete(parsed.value.id)) return;
    if (!this.#pending.has(parsed.value.id)) {
      this.#abortProtocol("Hopper returned an unknown response id");
      return;
    }
    this.#settle(parsed.value.id, responseResult(parsed.value));
  }

  #abortProtocol(message: string, cause?: Error): void {
    this.#failAll(new HopperProtocolError(message, { cause }));
    this.#socket?.destroy();
  }

  #settle(id: number, result: Result<JsonValue, HopperError>): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    pending.resolve(result);
  }

  #abandon(id: number, result: Result<JsonValue, HopperError>): void {
    if (!this.#pending.has(id)) return;
    this.#abandoned.add(id);
    if (this.#abandoned.size > MAX_ABANDONED_REQUESTS) {
      const oldest = this.#abandoned.values().next();
      if (!oldest.done) this.#abandoned.delete(oldest.value);
    }
    this.#settle(id, result);
  }

  #failAll(error: HopperError): void {
    for (const id of [...this.#pending.keys()]) this.#settle(id, err(error));
  }
}

const connectOnce = async (
  socketPath: string,
): Promise<Result<Socket, HopperStartError>> =>
  new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      resolve(ok(socket));
    });
    socket.once("error", (cause: Error) => {
      socket.destroy();
      resolve(err(new HopperStartError({ cause })));
    });
  });

const parseServerInfo = (
  value: JsonValue,
): Result<HopperServerInfo, HopperProtocolError> => {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.name === "betterBinaryMCP Hopper bridge" &&
    typeof value.version === "string"
  ) {
    return ok({ name: value.name, version: value.version });
  }
  return err(new HopperProtocolError("Hopper bridge health result is invalid"));
};
