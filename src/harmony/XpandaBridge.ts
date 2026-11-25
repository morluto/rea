import { z } from "zod";
import {
  OwnedMcpStdioTransport,
  type OwnedMcpLauncher,
} from "../process/OwnedMcpStdioTransport.js";
import { OwnedMcpClient } from "../process/OwnedMcpClient.js";
import type { OwnedProviderProcessSpawnOptions } from "../process/ProviderProcess.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { parseXpandaEnvelope } from "./XpandaProtocol.js";
import { XPANDA_PROVIDER_ID } from "./XpandaRelease.js";

/** The producer's initialize identity; the package version differs from it. */
export const XPANDA_BRIDGE_IDENTITY = { name: "xpanda" } as const;

interface ObservedCall {
  readonly operation: string;
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly response: JsonValue;
}

/**
 * One owned bridge connection to the caller-supplied xpanda MCP server.
 * Requests are serialized by the owning provider; the wire protocol stays
 * inside the HarmonyOS adapter.
 */
export class XpandaBridge {
  readonly transport: OwnedMcpStdioTransport;
  readonly #client = new OwnedMcpClient({
    name: "rea-harmony-adapter",
    version: "1",
  });
  #connected = false;
  readonly #observedCalls: ObservedCall[] = [];
  #serverName: string | null = null;
  #serverVersion: string | null = null;

  constructor(
    options: Omit<OwnedProviderProcessSpawnOptions, "runId" | "stdin">,
    launcher?: OwnedMcpLauncher,
  ) {
    this.transport = new OwnedMcpStdioTransport(
      options,
      {
        provider: XPANDA_PROVIDER_ID,
        label: "xpanda",
        maxFrameBytes: 8 * 1024 * 1024,
        maxOperationBytes: 32 * 1024 * 1024,
        notifyOnExit: true,
      },
      launcher,
    );
  }

  /** Connect once per bridge process and verify the producer identity. */
  async ensureConnected(context: {
    readonly operation: string;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
  }): Promise<void> {
    if (this.#connected) return;
    const abort = () => {
      void this.transport
        .interrupt(context.signal.reason)
        .catch(() => undefined);
    };
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      if (context.signal.aborted) abort();
      this.transport.beginOperation();
      await this.#client.connect(this.transport, { timeout: 30_000 });
      this.#connected = true;
      const server = this.#client.getServerVersion();
      this.#serverName = server?.name ?? null;
      this.#serverVersion = server?.version ?? null;
      if (server?.name !== XPANDA_BRIDGE_IDENTITY.name)
        throw new AnalysisCapabilityUnavailableError(
          XPANDA_PROVIDER_ID,
          context.operation,
          `Expected the ${XPANDA_BRIDGE_IDENTITY.name} MCP server; the configured checkout reported ${server?.name ?? "unknown"} ${server?.version ?? "unknown"}.`,
        );
    } finally {
      context.signal.removeEventListener("abort", abort);
    }
  }

  /**
   * Execute one producer tool call inside the operation budget and return
   * the envelope-checked producer text.
   */
  async call(
    operation: string,
    name: string,
    input: Readonly<Record<string, JsonValue>>,
    context: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ): Promise<string> {
    this.transport.beginOperation();
    // Keep an explicit bound: omitting it falls back to the SDK's 60-second default.
    const response = await this.#client.callTool(
      { name, arguments: input },
      { timeout: context.timeoutMs, signal: context.signal },
    );
    const observedResponse = jsonValueSchema.parse(response);
    this.#observedCalls.push({
      operation: name,
      input,
      response: observedResponse,
    });
    return parseXpandaEnvelope(operation, name, response);
  }

  /** Producer JSON tool results parsed and validated at this boundary. */
  async callJson<Schema extends { parse: (text: string) => unknown }>(
    operation: string,
    name: string,
    schema: Schema,
    input: Readonly<Record<string, JsonValue>>,
    context: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ): Promise<ReturnType<Schema["parse"]>> {
    const text = await this.call(operation, name, input, context);
    try {
      return schema.parse(JSON.parse(text)) as ReturnType<Schema["parse"]>;
    } catch (cause: unknown) {
      if (cause instanceof z.ZodError) throw cause;
      throw new ProviderAdapterError(XPANDA_PROVIDER_ID, operation, {
        cause,
        diagnostics: {
          upstream_operation: name,
          reason: "The xpanda tool result was not the documented JSON document",
        },
      });
    }
  }

  /** Facts and upstream replies retained if a later request step fails. */
  observedCalls(): readonly ObservedCall[] {
    return [...this.#observedCalls];
  }

  serverIdentity(): {
    readonly name: string | null;
    readonly version: string | null;
  } {
    return { name: this.#serverName, version: this.#serverVersion };
  }

  /** Whether the configured checkout established the producer bridge protocol. */
  initialized(): boolean {
    return this.#connected;
  }

  /** Join owned cleanup even if SDK connection teardown itself fails. */
  async close(): Promise<void> {
    try {
      if (this.#connected) await this.#client.close();
    } finally {
      this.#connected = false;
      await this.transport.close();
    }
  }
}
