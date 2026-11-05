import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getHeapStatistics } from "node:v8";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

import { jsonObjectSchema, type JsonValue } from "../domain/jsonValue.js";
import { StructuredContentMcpClient } from "../providers/StructuredContentMcpClient.js";
import { validateMcpHttpResponse } from "../providers/Utf8McpResponse.js";
import type {
  ComputerHelper,
  ComputerRelease,
} from "./AgentEnvComputerHelper.js";

const READY_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 120_000;
const PROGRESS_MS = 5_000;
const RECORDINGS = ".agentenv-recordings";
/** A control route's answer: readiness, or a recording's manifest, near 1.5 MB for a day of 15 s segments. */
const CONTROL_RESPONSE_BYTES = 4 * 1024 * 1024;
/** What a data/get answer holds around one file's base64 bytes. */
const ENVELOPE_BYTES = 64 * 1024;
/** An exec answer: two streams of at most 1 MiB each, which JSON escaping can grow sixfold. */
const EXEC_RESPONSE_BYTES = 16 * 1024 * 1024;
/** The base64 answer for `bytes` of files, with each file's envelope. */
const dataAnswerBytes = (bytes: number, files: number) =>
  Math.ceil(bytes / 3) * 4 + ENVELOPE_BYTES * Math.max(files, 1);
/** The most REA reads into memory for one answer of unknown size: a quarter of the V8 heap, as for recordings. */
const heapQuarter = () => Math.floor(getHeapStatistics().heap_size_limit / 4);

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
const rpcSchema = z.union([
  z.object({ result: z.looseObject({}) }),
  z.object({ error: z.looseObject({ message: z.string() }) }),
]);
const execSchema = z.object({
  exit_code: z.int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  timed_out: z.boolean(),
});
/** A command's outcome through `computer-exec/v1`, its output without the control token. */
export type ComputerCommandResult = z.infer<typeof execSchema>;
const cardSchema = z.looseObject({
  children_environments: z
    .array(z.looseObject({ name: z.string(), url: z.string().optional() }))
    .optional(),
});

/** How long a route may take and how much of its answer REA reads. */
interface RequestBounds {
  readonly limit?: { readonly bytes: number; readonly what: string };
  readonly timeoutMs?: number;
}

/** A driver tool's answer as REA forwards it: its content blocks unchanged and its structured result. */
export interface DriverResult {
  readonly isError: boolean;
  readonly content: readonly Readonly<Record<string, JsonValue>>[];
  readonly structured: Readonly<Record<string, JsonValue>> | null;
}

/** A response body read only while it stays within `maxBytes`. */
const readBounded = async (
  response: Response,
  maxBytes: number,
  what: string,
): Promise<string> => {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (response.body !== null)
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes)
        throw new Error(`${what} is more than ${String(maxBytes)} bytes.`);
      chunks.push(chunk);
    }
  return Buffer.concat(chunks, bytes).toString("utf8");
};

/** Why a computer did not come up, with what the caller can do about it. */
export class ComputerStartFailure extends Error {
  constructor(
    message: string,
    readonly remediation: string | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ComputerStartFailure";
  }
}

/** Every few seconds while a computer comes up, report the phase and agentenv's latest line. */
const progressHeartbeat = (
  helper: ComputerHelper,
  phase: { readonly name: string },
  progress: ((message: string) => void) | undefined,
) => {
  if (progress === undefined) return undefined;
  const startedAt = Date.now();
  return setInterval(() => {
    const line = helper
      .output()
      .stderr.trimEnd()
      .split("\n")
      .at(-1)
      ?.slice(-200);
    progress(
      `${phase.name} (${String(Math.round((Date.now() - startedAt) / 1000))} s)${line === undefined || line === "" ? "" : `: ${line}`}`,
    );
  }, PROGRESS_MS);
};

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
   * Connect to the computer a helper keeps up: wait for its handshake and
   * readiness and open an MCP session to its driver. A failure throws a
   * `ComputerStartFailure`, or the signal's reason when cancelled; the
   * helper's owner releases it either way.
   */
  static async connect(
    helper: ComputerHelper,
    signal: AbortSignal,
    progress?: (message: string) => void,
  ): Promise<AgentEnvComputer> {
    const phase = { name: "agentenv is deploying the computer" };
    const heartbeat = progressHeartbeat(helper, phase, progress);
    try {
      return await AgentEnvComputer.#connect(helper, signal, phase);
    } finally {
      clearInterval(heartbeat);
    }
  }

  static async #connect(
    helper: ComputerHelper,
    signal: AbortSignal,
    phase: { name: string },
  ): Promise<AgentEnvComputer> {
    const handshake = await helper.handshake(signal);
    if (handshake === undefined || "error" in handshake)
      throw new ComputerStartFailure(
        `agentenv did not bring the computer up: ${handshake?.error ?? "its helper ended without a handshake"}.`,
        "Read the helper's output; `agent-env run <bundle> --task smoke --no-emulate` reproduces the deploy.",
      );
    phase.name = "waiting for the computer's readiness checks";
    let client: StructuredContentMcpClient | undefined;
    try {
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
      if (signal.aborted) throw signal.reason;
      throw new ComputerStartFailure(
        `The computer came up but REA could not use it: ${cause instanceof Error ? cause.message : String(cause)}`,
        undefined,
        { cause },
      );
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

  /**
   * Fetch an ended recording's segments through the driver's data plane,
   * one request per segment, each read within its manifest size and checked
   * against it. A recording larger than `maxBytes`, by default a quarter of
   * the V8 heap as for retained Evidence, is refused before any read.
   */
  async recordingSegments(
    manifest: RecordingManifest,
    signal?: AbortSignal,
    maxBytes = Math.floor(getHeapStatistics().heap_size_limit / 4),
  ): Promise<readonly { readonly path: string; readonly bytes: Buffer }[]> {
    const total = manifest.segments.reduce(
      (sum, segment) => sum + segment.bytes,
      0,
    );
    if (total > maxBytes)
      throw new Error(
        `Recording ${manifest.recording_id} holds ${String(total)} bytes, more than the ${String(maxBytes)} REA reads into memory for one recording; end recordings sooner so each stays smaller.`,
      );
    const segments: { readonly path: string; readonly bytes: Buffer }[] = [];
    for (const segment of manifest.segments)
      segments.push({
        path: segment.path,
        bytes: await this.#segment(segment, signal),
      });
    return segments;
  }

  async #segment(
    segment: RecordingManifest["segments"][number],
    signal: AbortSignal | undefined,
  ): Promise<Buffer> {
    const path = `${RECORDINGS}/${segment.path}`;
    const answer = dataGetSchema.parse(
      await this.#request(
        "/agentenv",
        {
          jsonrpc: "2.0",
          id: segment.index + 1,
          method: "data/get",
          params: { paths: [path] },
        },
        signal,
        {
          limit: {
            // Base64 plus the JSON-RPC envelope and the part's metadata.
            bytes: Math.ceil(segment.bytes / 3) * 4 + ENVELOPE_BYTES,
            what: `The computer's answer for recording segment ${segment.path}`,
          },
        },
      ),
    );
    if ("error" in answer)
      throw new Error(
        `data/get of recording segment ${segment.path} failed: ${answer.error.message}`,
      );
    const encoded = answer.result.parts.find(
      (part) => Object.values(part.metadata ?? {})[0]?.path === path,
    )?.file?.bytes;
    const bytes =
      encoded === undefined ? undefined : Buffer.from(encoded, "base64");
    if (
      bytes?.length !== segment.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== segment.sha256
    )
      throw new Error(
        `Recording segment ${segment.path} is missing or differs from its manifest.`,
      );
    return bytes;
  }

  /**
   * The files under paths of the computer user's home, by home path, through
   * the driver's `data/get`; its answer is read within `bytes` of files.
   */
  async homeFiles(
    paths: readonly string[],
    bytes: number,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, Buffer>> {
    const answer = dataGetSchema.parse(
      await this.#request(
        "/agentenv",
        { jsonrpc: "2.0", id: 1, method: "data/get", params: { paths } },
        signal,
        {
          limit: {
            bytes: dataAnswerBytes(bytes, paths.length),
            what: `The computer's answer for ${paths.join(", ")}`,
          },
        },
      ),
    );
    if ("error" in answer)
      throw new Error(
        `data/get failed: ${this.#redacted(answer.error.message)}`,
      );
    return new Map(
      answer.result.parts.flatMap((part) => {
        const path = Object.values(part.metadata ?? {})[0]?.path;
        const encoded = part.file?.bytes;
        return path === undefined || encoded === undefined
          ? []
          : [[path, Buffer.from(encoded, "base64")] as const];
      }),
    );
  }

  /** Run a command in the computer's desktop session as its user; output is cut at the computer's cap. */
  async exec(
    argv: readonly string[],
    timeoutS: number,
    signal?: AbortSignal,
  ): Promise<ComputerCommandResult> {
    const result = execSchema.parse(
      await this.#request(
        "/agentenv/ext/computer-exec/run",
        { argv, request_id: randomUUID(), timeout_s: timeoutS },
        signal,
        {
          limit: {
            bytes: EXEC_RESPONSE_BYTES,
            what: `The computer's answer to ${argv[0] ?? "a command"}`,
          },
          timeoutMs: (timeoutS + 30) * 1000,
        },
      ),
    );
    return {
      ...result,
      stdout: this.#redacted(result.stdout),
      stderr: this.#redacted(result.stderr),
    };
  }

  /**
   * The parts the computer's one app answers a data method with: `data/get`,
   * read within a quarter of the V8 heap since it carries the app's files, or
   * `data/reset`.
   */
  async appData(
    method: "data/get" | "data/reset",
    signal?: AbortSignal,
  ): Promise<readonly unknown[]> {
    const card = cardSchema.parse(
      await this.#request("/.well-known/agent-env.json", undefined, signal),
    );
    const [app, ...others] = card.children_environments ?? [];
    if (app === undefined || others.length > 0)
      throw new Error(
        `The computer lists ${String(card.children_environments?.length ?? 0)} apps; REA reads a computer with one app.`,
      );
    const path = new URL(app.url ?? `/svc/${app.name}/agentenv`, this.#baseUrl)
      .pathname;
    const answer = rpcSchema.parse(
      await this.#request(
        path,
        { jsonrpc: "2.0", id: 1, method, params: {} },
        signal,
        {
          limit: {
            bytes: heapQuarter(),
            what: `The ${app.name} app's ${method} answer`,
          },
        },
      ),
    );
    if ("error" in answer)
      throw new Error(
        `${method} failed: ${this.#redacted(answer.error.message)}`,
      );
    return method === "data/get"
      ? z.object({ parts: z.array(z.unknown()) }).parse(answer.result).parts
      : [];
  }

  /** Wait until the computer's readiness checks pass, as after a reset relaunches its app. */
  async waitUntilReady(signal: AbortSignal): Promise<void> {
    await this.#waitReady(signal);
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

  #redacted(text: string): string {
    return this.#token === null
      ? text
      : text.replaceAll(this.#token, "[control token]");
  }

  /** A framework-only route of the computer, with its control token; its answer is read within `bounds.limit`. */
  async #request(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    bounds: RequestBounds = {},
  ): Promise<unknown> {
    const limit = bounds.limit ?? {
      bytes: CONTROL_RESPONSE_BYTES,
      what: `The computer's answer to ${path}`,
    };
    const timeout = AbortSignal.timeout(bounds.timeoutMs ?? REQUEST_TIMEOUT_MS);
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
    const text = await readBounded(response, limit.bytes, limit.what);
    if (!response.ok)
      throw new Error(
        `The computer answered ${path} with HTTP ${String(response.status)}: ${this.#redacted(text.slice(0, 512))}`,
      );
    return JSON.parse(text) as unknown;
  }
}
