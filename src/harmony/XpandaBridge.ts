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
import {
  XPANDA_PROVIDER_ID,
  XPANDA_VERIFIED_VERSION,
} from "./XpandaRelease.js";
import type { HarmonyAbcOperation } from "../domain/harmony/harmonyAbcAnalysis.js";

/** The producer's initialize identity; the package version differs from it. */
export const XPANDA_BRIDGE_IDENTITY = { name: "xpanda" } as const;

/** Producer tools each REA operation requires from the configured release. */
const OPERATION_TOOLS: Readonly<Record<HarmonyAbcOperation, string>> = {
  inspect_harmony_abc: "abc_load",
  list_harmony_abc_classes: "abc_list_classes",
  inspect_harmony_abc_class: "abc_get_class",
  decompile_harmony_abc_class: "abc_decompile_class",
  decompile_harmony_abc_method: "abc_decompile_method",
  decompile_harmony_abc: "abc_export",
  disassemble_harmony_abc_method: "abc_disassemble_method",
  search_harmony_abc_strings: "abc_search_strings",
  search_harmony_abc_symbols: "abc_search_symbols",
  search_harmony_abc_code: "abc_search_code",
  trace_harmony_abc_references: "abc_xrefs",
  build_harmony_abc_call_graph: "abc_call_graph",
  inspect_harmony_hap_abc: "hap_read_abc",
  inspect_harmony_hap_resources: "hap_resources",
};

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
  #toolNames: ReadonlySet<string> | undefined;

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

  /**
   * Refuse an operation the configured producer does not advertise. Later
   * majors add tools; REA names the missing tool instead of surfacing an
   * unknown-tool protocol failure.
   */
  async requireTool(
    operation: HarmonyAbcOperation,
    context: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ): Promise<void> {
    const required = OPERATION_TOOLS[operation];
    if (this.#toolNames === undefined) {
      const listed = await this.#client.listTools(undefined, {
        timeout: context.timeoutMs,
        signal: context.signal,
      });
      this.#toolNames = new Set(listed.tools.map((tool) => tool.name));
    }
    if (!this.#toolNames.has(required))
      throw new AnalysisCapabilityUnavailableError(
        XPANDA_PROVIDER_ID,
        operation,
        `The configured xpanda release does not advertise ${required}, which this operation requires.`,
        {
          userMessage: `The configured xpanda release has no ${required} tool.`,
          remediationAction: `Update the caller-supplied xpanda checkout to a release that provides ${required} (REA verified ${XPANDA_VERIFIED_VERSION}).`,
        },
      );
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
