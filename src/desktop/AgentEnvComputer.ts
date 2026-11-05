import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type { AnalysisCleanupObservation } from "../domain/analysisErrorBase.js";
import { jsonObjectSchema, type JsonValue } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { StructuredContentMcpClient } from "../providers/StructuredContentMcpClient.js";
import { validateMcpHttpResponse } from "../providers/Utf8McpResponse.js";
import {
  AGENTENV_PROVIDER,
  ComputerHelper,
  type ComputerRelease,
} from "./AgentEnvComputerHelper.js";

const READY_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 120_000;
const RECORDINGS = ".agentenv-recordings";

const readinessSchema = z.object({
  ready: z.boolean(),
  checks: z
    .array(
      z.object({
        name: z.string(),
        ok: z.boolean(),
        detail: z.string().nullish(),
        final: z.boolean().optional(),
      }),
    )
    .default([]),
});
const recordingId = z.string().regex(/^rec-[0-9a-f]+$/u);
const recordingStartSchema = z.looseObject({
  recording_id: recordingId,
  started_at: z.string(),
});
const recordingManifestSchema = z.looseObject({
  recording_id: recordingId,
  segments: z.array(
    z.looseObject({
      index: z.int().nonnegative(),
      path: z.string(),
      bytes: z.int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    }),
  ),
});
/** An ended recording's manifest, as `computer-recording/v1` returns it. */
export type RecordingManifest = z.infer<typeof recordingManifestSchema>;
const dataGetSchema = z.union([
  z.object({
    result: z.object({
      parts: z.array(
        z.looseObject({
          file: z.looseObject({ bytes: z.string().optional() }).optional(),
          metadata: z
            .record(z.string(), z.looseObject({ path: z.string().optional() }))
            .optional(),
        }),
      ),
    }),
  }),
  z.object({ error: z.looseObject({ message: z.string() }) }),
]);

/** A driver tool's answer as REA forwards it: its content blocks unchanged and its structured result. */
export interface DriverResult {
  readonly isError: boolean;
  readonly content: readonly Readonly<Record<string, JsonValue>>[];
  readonly structured: Readonly<Record<string, JsonValue>> | null;
}

const cleanupOf = (
  release: ComputerRelease,
): { readonly cleanup?: AnalysisCleanupObservation } =>
  release.verified
    ? {}
    : { cleanup: { reason: release.reason, resources: release.resources } };

const connectDriver = async (
  mcpUrl: string,
  signal: AbortSignal,
): Promise<StructuredContentMcpClient> => {
  const client = new StructuredContentMcpClient({
    name: "rea-build-computer",
    version: "1",
  });
  const transport: StreamableHTTPClientTransport =
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { redirect: "error" },
      fetch: async (input, init) =>
        validateMcpHttpResponse(await fetch(input, init), () => {
          void transport.close().catch(() => undefined);
        }),
    });
  await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS, signal });
  return client;
};

/**
 * One agentenv computer kept up for REA: the helper that holds it, one MCP
 * session to its driver, and its control token, which never leaves this
 * object.
 */
export class AgentEnvComputer {
  readonly sandboxId: string;
  readonly #baseUrl: string;
  readonly #token: string | null;
  readonly #helper: ComputerHelper;
  readonly #client: StructuredContentMcpClient;

  private constructor(parts: {
    readonly sandboxId: string;
    readonly baseUrl: string;
    readonly token: string | null;
    readonly helper: ComputerHelper;
    readonly client: StructuredContentMcpClient;
  }) {
    this.sandboxId = parts.sandboxId;
    this.#baseUrl = parts.baseUrl;
    this.#token = parts.token;
    this.#helper = parts.helper;
    this.#client = parts.client;
  }

  /**
   * Keep a bundle's computer up with REA's helper, wait until the computer
   * reports ready and open an MCP session to its driver. Failure or
   * cancellation brings the computer down before the typed error returns.
   */
  static async start(options: {
    readonly bundle: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly signal: AbortSignal;
    readonly operation: string;
  }): Promise<AgentEnvComputer> {
    const { signal, operation } = options;
    const helper = await ComputerHelper.spawn(options);
    let client: StructuredContentMcpClient | undefined;
    try {
      const handshake = await helper.handshake(signal);
      if (handshake === undefined || "error" in handshake) {
        const release = await helper.release();
        throw new ProviderAdapterError(AGENTENV_PROVIDER, operation, {
          userMessage: `agentenv did not bring the computer up: ${handshake?.error ?? "its helper ended without a handshake"}.`,
          remediationAction:
            "Read the helper's output; `agent-env run <bundle> --task smoke --no-emulate` reproduces the deploy.",
          capturedOutput: helper.output(),
          ...cleanupOf(release),
        });
      }
      client = await connectDriver(handshake.mcp_url, signal);
      const computer = new AgentEnvComputer({
        sandboxId: handshake.sandbox_id,
        baseUrl: handshake.base_url.replace(/\/+$/u, ""),
        token: handshake.control_token,
        helper,
        client,
      });
      await computer.#waitReady(signal);
      return computer;
    } catch (cause: unknown) {
      await client?.close().catch(() => undefined);
      if (cause instanceof ProviderAdapterError) throw cause;
      const cleanup = cleanupOf(await helper.release());
      if (signal.aborted)
        throw new AnalysisCancelledError(operation, {
          cause: signal.reason,
          ...cleanup,
        });
      throw new ProviderAdapterError(AGENTENV_PROVIDER, operation, {
        userMessage: `The computer came up but REA could not use it: ${cause instanceof Error ? cause.message : String(cause)}`,
        capturedOutput: helper.output(),
        cause,
        ...cleanup,
      });
    }
  }

  /** Call one of the driver's `computer_*` tools on REA's MCP session. */
  async callTool(
    name: string,
    args: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal,
  ): Promise<DriverResult> {
    const result = await this.#client.callTool(
      { name, arguments: args },
      { timeout: REQUEST_TIMEOUT_MS, signal },
    );
    const structured = jsonObjectSchema.safeParse(result.structuredContent);
    return {
      isError: result.isError === true,
      content: result.content.map((block) => jsonObjectSchema.parse(block)),
      structured: structured.success ? structured.data : null,
    };
  }

  /** Start a recording under the caller's request id; repeating the id answers the same recording. */
  async startRecording(requestId: string, signal?: AbortSignal) {
    return recordingStartSchema.parse(
      await this.#request(
        "/agentenv/ext/computer-recording/start",
        { request_id: requestId },
        signal,
      ),
    );
  }

  /** End a recording; its manifest lists the segments the computer keeps until teardown. */
  async endRecording(
    id: string,
    signal?: AbortSignal,
  ): Promise<RecordingManifest> {
    return recordingManifestSchema.parse(
      await this.#request(
        "/agentenv/ext/computer-recording/end",
        { recording_id: id },
        signal,
      ),
    );
  }

  /** Fetch an ended recording's segments through the driver's data plane, each checked against its manifest. */
  async recordingSegments(
    manifest: RecordingManifest,
    signal?: AbortSignal,
  ): Promise<readonly { readonly path: string; readonly bytes: Buffer }[]> {
    const answer = dataGetSchema.parse(
      await this.#request(
        "/agentenv",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "data/get",
          params: { paths: [`${RECORDINGS}/${manifest.recording_id}`] },
        },
        signal,
      ),
    );
    if ("error" in answer)
      throw new Error(
        `data/get of the recording failed: ${answer.error.message}`,
      );
    const files = new Map(
      answer.result.parts.flatMap((part) => {
        const path = Object.values(part.metadata ?? {})[0]?.path;
        const bytes = part.file?.bytes;
        return path === undefined || bytes === undefined
          ? []
          : [[path, Buffer.from(bytes, "base64")] as const];
      }),
    );
    return manifest.segments.map((segment) => {
      const bytes = files.get(`${RECORDINGS}/${segment.path}`);
      if (
        bytes?.length !== segment.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== segment.sha256
      )
        throw new Error(
          `Recording segment ${segment.path} is missing or differs from its manifest.`,
        );
      return { path: segment.path, bytes };
    });
  }

  /** End REA's MCP session and bring the computer down; a failed release can be retried. */
  async close(): Promise<ComputerRelease> {
    await this.#client.close().catch(() => undefined);
    return this.#helper.release();
  }

  async #waitReady(signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const status = readinessSchema.parse(
        await this.#request(
          "/agentenv/ext/computer-ready/status",
          undefined,
          signal,
        ),
      );
      if (status.ready) return;
      const waiting = status.checks.filter((check) => !check.ok);
      const failed = waiting.find((check) => check.final === true);
      if (failed !== undefined || Date.now() > deadline)
        throw new Error(
          failed === undefined
            ? `The computer was not ready within ${String(READY_TIMEOUT_MS / 1000)} s; waiting on ${waiting.map((check) => check.name).join(", ")}.`
            : `The computer's ${failed.name} check failed: ${failed.detail ?? "no detail"}.`,
        );
      await delay(500, undefined, { signal });
    }
  }

  /** A framework-only route of the computer, with its control token. */
  async #request(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(this.#token === null
          ? {}
          : { authorization: `Bearer ${this.#token}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal:
        signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `The computer answered ${path} with HTTP ${String(response.status)}: ${text.slice(0, 512)}`,
      );
    return JSON.parse(text) as unknown;
  }
}
