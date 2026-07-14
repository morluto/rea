import WebSocket, { type RawData } from "ws";

import {
  AnalysisCancelledError,
  AnalysisError,
  AnalysisTimeoutError,
  BrowserObservationError,
} from "../domain/errors.js";

export interface CdpEvent {
  readonly method: string;
  readonly params: unknown;
  readonly sessionId?: string;
}

interface PendingCommand {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: AnalysisError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly removeAbort: () => void;
}

const CONNECT_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 5_000;
const MAX_PAYLOAD_BYTES = 16 * 1_024 * 1_024;
const MAX_PENDING_COMMANDS = 128;

/** Correlated, bounded JSON-RPC transport for a browser-level CDP socket. */
export class CdpConnection {
  readonly #pending = new Map<number, PendingCommand>();
  readonly #listeners = new Set<(event: CdpEvent) => void>();
  #nextId = 1;
  #closed = false;
  #protocolFailed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => this.#receive(data));
    socket.on("close", () => this.#failPending("disconnected"));
    socket.on("error", () => this.#failPending("disconnected"));
  }

  /** Connect to one already-validated loopback browser WebSocket. */
  static async connect(
    url: string,
    signal?: AbortSignal,
  ): Promise<CdpConnection> {
    if (signal?.aborted === true)
      throw new AnalysisCancelledError("inspect_web_page");
    const socket = new WebSocket(url, {
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      maxPayload: MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });
    await waitForOpen(socket, signal);
    return new CdpConnection(socket);
  }

  /** Subscribe to validated CDP event envelopes. */
  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Execute one bounded command, optionally within a flat target session. */
  async send(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#protocolFailed)
      throw new BrowserObservationError("inspect_web_page", "protocol_error");
    if (this.#closed || this.socket.readyState !== WebSocket.OPEN)
      throw new BrowserObservationError("inspect_web_page", "disconnected");
    if (this.#pending.size >= MAX_PENDING_COMMANDS)
      throw new BrowserObservationError("inspect_web_page", "payload_limit");
    if (signal?.aborted === true)
      throw new AnalysisCancelledError("inspect_web_page");
    const id = this.#nextId;
    this.#nextId += 1;
    return await new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        pending.removeAbort();
        this.#pending.delete(id);
        reject(new AnalysisCancelledError("inspect_web_page"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(id);
        reject(
          new AnalysisTimeoutError("inspect_web_page", COMMAND_TIMEOUT_MS),
        );
      }, COMMAND_TIMEOUT_MS);
      this.#pending.set(id, {
        resolve,
        reject,
        timer,
        removeAbort: () => signal?.removeEventListener("abort", onAbort),
      });
      this.socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
        (error) => {
          if (error === undefined || error === null) return;
          const pending = this.#pending.get(id);
          if (pending === undefined) return;
          this.#complete(id, pending);
          reject(
            new BrowserObservationError("inspect_web_page", "disconnected", {
              cause: error,
            }),
          );
        },
      );
    });
  }

  /** Close only REA's socket; never close the browser or selected page. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#failPending("disconnected");
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, 1_000);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.close();
    });
  }

  #receive(data: RawData): void {
    let message: unknown;
    try {
      message = JSON.parse(rawText(data));
    } catch {
      this.#failPending("protocol_error");
      return;
    }
    if (!isRecord(message)) {
      this.#failPending("protocol_error");
      return;
    }
    if ("id" in message) {
      if (
        typeof message.id !== "number" ||
        !Number.isSafeInteger(message.id) ||
        message.id < 1
      ) {
        this.#failPending("protocol_error");
        return;
      }
      this.#receiveResponse(message, message.id);
      return;
    }
    if (
      typeof message.method !== "string" ||
      message.method.length === 0 ||
      ("params" in message && !isRecord(message.params)) ||
      ("sessionId" in message && typeof message.sessionId !== "string")
    ) {
      this.#failPending("protocol_error");
      return;
    }
    const event: CdpEvent = {
      method: message.method,
      params: "params" in message ? message.params : {},
      ...(typeof message.sessionId === "string"
        ? { sessionId: message.sessionId }
        : {}),
    };
    for (const listener of this.#listeners) listener(event);
  }

  #receiveResponse(message: Record<string, unknown>, id: number): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#complete(id, pending);
    if ("error" in message) {
      pending.reject(
        new BrowserObservationError("inspect_web_page", "protocol_error"),
      );
      return;
    }
    pending.resolve("result" in message ? message.result : {});
  }

  #complete(id: number, pending: PendingCommand): void {
    clearTimeout(pending.timer);
    pending.removeAbort();
    this.#pending.delete(id);
  }

  #failPending(reason: "disconnected" | "protocol_error"): void {
    if (reason === "disconnected") this.#closed = true;
    else this.#protocolFailed = true;
    for (const [id, pending] of this.#pending) {
      this.#complete(id, pending);
      pending.reject(new BrowserObservationError("inspect_web_page", reason));
    }
  }
}

const rawText = (data: RawData): string =>
  Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : Buffer.isBuffer(data)
      ? data.toString("utf8")
      : Buffer.from(data).toString("utf8");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const waitForOpen = async (
  socket: WebSocket,
  signal?: AbortSignal,
): Promise<void> =>
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      terminateSocket(socket);
      reject(new AnalysisTimeoutError("inspect_web_page", CONNECT_TIMEOUT_MS));
    }, CONNECT_TIMEOUT_MS);
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onFailure = (cause: unknown): void => {
      cleanup();
      reject(
        signal?.aborted === true
          ? new AnalysisCancelledError("inspect_web_page")
          : new BrowserObservationError(
              "inspect_web_page",
              "endpoint_unreachable",
              { cause },
            ),
      );
    };
    const onAbort = (): void => {
      terminateSocket(socket);
      onFailure(new AnalysisCancelledError("inspect_web_page"));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onFailure);
      signal?.removeEventListener("abort", onAbort);
    };
    socket.once("open", onOpen);
    socket.once("error", onFailure);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });

const terminateSocket = (socket: WebSocket): void => {
  socket.once("error", () => undefined);
  socket.terminate();
};
