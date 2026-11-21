import {
  ArtifactResourceScope,
  type ArtifactResourceOwner,
  bindArtifactFileCleanup,
} from "../resources/index.js";
import { ResponseBodyCleanup } from "../providers/ResponseBodyCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  mcpToolResultSchema,
  mcpTextBlocks,
  decodeMcpJsonText,
} from "../providers/McpToolResult.js";
import { StructuredContentMcpClient } from "../providers/StructuredContentMcpClient.js";
import {
  createIdaDiagnosticRedactor,
  IDA_DIAGNOSTIC_SOURCE_BYTES,
} from "./IdaDiagnosticRedactor.js";
import { IdaDiagnosticResourceError } from "./IdaDiagnosticWriter.js";
import { MIMEType } from "node:util";
import {
  mergeEnvironmentOverrides,
  snapshotEnvironment,
} from "../process/snapshotEnvironment.js";
import {
  OwnedMcpStdioTransport,
  type OwnedMcpLauncher,
} from "../process/OwnedMcpStdioTransport.js";
import { spawnOwnedProviderProcess } from "../process/ProviderProcess.js";
import { findWindowsExecutable } from "../process/WindowsExecutable.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import {
  isWindowsBatchFile,
  windowsBatchCommand,
} from "../process/WindowsBatchCommand.js";
import {
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import {
  idaRegistrationTimeoutGuidance,
  type IdaConfiguration,
} from "./IdaConfiguration.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  AnalysisTimeoutError,
  AnalysisCancelledError,
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
  cancelledBy,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import {
  McpHttpUtf8Error,
  validateMcpHttpResponse,
} from "../providers/Utf8McpResponse.js";

/** A completed upstream tool reply that reported failure, as opposed to an unreadable or missing reply. */
export class IdaToolRejection extends AnalysisProtocolError {}

/** Injectable MCP boundary used by the provider and transport conformance tests. */
export interface IdaMcpConnection {
  connect(): Promise<readonly string[]>;
  call(
    name: string,
    args: Readonly<Record<string, JsonValue>>,
    options?: {
      readonly timeoutMs?: number | undefined;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<JsonValue>;
  readResource?(
    uri: string,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<JsonValue>;
  serverInfo(): JsonValue;
  close(): Promise<void>;
  /**
   * Keep a connection retained after failed cleanup from holding the host
   * process open. A long-lived MCP server can still retry through it; a
   * one-shot CLI exits, and the upstream proxy observes end of input.
   */
  detach(): void;
}

export type IdaMcpConnectionDependencies = Readonly<{
  createDiagnosticRedactor?: typeof createIdaDiagnosticRedactor;
  /**
   * Host platform that selects the Windows launch resolution and the
   * environment-name semantics of the child's environment snapshot.
   * Composition passes the running host.
   */
  platform: NodeJS.Platform;
  /** Owned process acquisition for a stdio registration. */
  launcher?: OwnedMcpLauncher;
  /** Largest stdio JSON-RPC message accepted from the upstream server. */
  maxStdioMessageBytes?: number;
}>;

const toolResultSchema = mcpToolResultSchema.extend({
  _meta: z
    .object({
      ida_mcp: z
        .object({
          output_truncated: z.boolean().optional(),
          download_hint: z.string().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
});

const IDA_STDIO_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const IDA_STDERR_TAIL_BYTES = 16_384;

/**
 * Windows creates owned processes from an absolute drive-path executable only,
 * without appending an extension, and runs `.bat`/`.cmd` launchers only through
 * cmd.exe. Resolve the registration command against the child's PATH/PATHEXT
 * and route batch launchers through the shared non-AutoRun cmd.exe invocation.
 */
const idaStdioLauncher =
  (
    platform: NodeJS.Platform,
    launch: OwnedMcpLauncher,
    timeoutMs: number,
  ): OwnedMcpLauncher =>
  async (options) => {
    if (platform !== "win32") return launch(options);
    const environment = mergeEnvironmentOverrides(
      options.hostEnvironment ?? {},
      options.env ?? {},
      "win32",
    );
    // The registration timeout bounds the PATH search, and the owned
    // transport aborts its signal when it closes, so a lookup that stalls on
    // an unreachable PATH directory holds neither connect nor shutdown open.
    const deadline = new ProviderStartupDeadline(timeoutMs, options.signal);
    const found = await findWindowsExecutable(options.command, environment, {
      signal: deadline.signal,
      allowBatch: true,
    }).finally(() => deadline.dispose());
    if (!found.ok && found.error.kind === "interrupted")
      throw deadline.interruption === "timeout"
        ? new AnalysisTimeoutError("ida_mcp_connect", timeoutMs, {
            cause: found.error,
            diagnostics: { phase: "windows_path_lookup" },
            ...idaRegistrationTimeoutGuidance(timeoutMs, "request"),
          })
        : (options.signal?.reason ??
            new Error("IDA MCP command lookup was interrupted"));
    if (!found.ok) {
      const failure = found.error;
      // An unreadable candidate is not a missing command: keep the path and
      // filesystem code so a denied install is distinguishable from none.
      throw new Error(
        failure.kind === "invalid_extension"
          ? "Windows PATHEXT must contain filename extensions, not paths"
          : failure.kind === "inspection"
            ? `IDA MCP command candidate ${JSON.stringify(failure.path)} could not be inspected (${failure.code ?? "unknown error"})`
            : `IDA MCP command ${JSON.stringify(options.command)} was not found at its path or on the registration PATH/PATHEXT`,
        { cause: failure.kind === "inspection" ? failure.cause : failure },
      );
    }
    const command = found.value;
    // The owned Windows launcher creates processes from drive paths only.
    if (!/^[a-z]:\\/iu.test(command))
      throw new Error(
        `IDA MCP command ${JSON.stringify(command)} is not on a drive path; map its network share to a drive letter or install the server locally`,
      );
    if (!isWindowsBatchFile(command)) return launch({ ...options, command });
    return launch({
      ...options,
      ...windowsBatchCommand({
        environment,
        batchPath: command,
        arguments: options.arguments,
      }),
      windowsVerbatimArguments: true,
    });
  };

const parseIdaTextReply = (text: string): JsonValue => {
  const decoded = decodeMcpJsonText(text);
  if (!decoded.ok)
    throw new AnalysisProtocolError("IDA MCP returned malformed JSON text.");
  return decoded.value;
};

/**
 * Decode Python FastMCP's scalar wrapper without dropping structured
 * dictionaries. A text block is read as JSON.
 */
export const decodeIdaToolResult = (
  input: unknown,
  protocol?: "native" | "hexrays",
  diagnostic: IdaDiagnosticRedactor = createIdaDiagnosticRedactor(),
): JsonValue => {
  const result = toolResultSchema.parse(input);
  const blocks = mcpTextBlocks(result.content);
  if (result.isError === true) {
    const reason = diagnostic.blocks(blocks);
    throw new IdaToolRejection(
      diagnostic.message("IDA MCP tool failed: ", reason),
      {
        diagnostics: { reason },
      },
    );
  }
  if (result._meta?.ida_mcp?.output_truncated === true)
    throw new AnalysisProtocolError(
      diagnostic.message(
        "IDA MCP truncated its output; the preview cannot establish a complete observation. ",
        diagnostic.blocks([
          result._meta.ida_mcp.download_hint ??
            "Use the upstream output download workflow to retrieve the full result.",
        ]),
      ),
    );
  // Native MCP retains the complete JSON text while structuredContent may
  // contain a shortened preview. Parse that producer-owned representation once.
  const text = blocks.length === 1 ? blocks[0] : undefined;
  if (protocol === "native") {
    if (text === undefined)
      throw new AnalysisProtocolError(
        "Native IDA MCP omitted its complete JSON text result.",
      );
    return parseIdaTextReply(text);
  }
  if (result.structuredContent !== undefined) {
    const value = jsonObjectSchema.parse(result.structuredContent);
    return Object.keys(value).length === 1 && Object.hasOwn(value, "result")
      ? value.result!
      : value;
  }
  if (text === undefined)
    throw new AnalysisProtocolError(
      "IDA MCP omitted a single structured or text result; unsupported content cannot establish an empty observation.",
    );
  return parseIdaTextReply(text);
};

// Retain only producer-sanitized JSON diagnostics, never a native parser cause.
class IdaHttpJsonError extends Error {
  constructor(text: string, redactor: IdaDiagnosticRedactor) {
    super(
      redactor.message(
        "IDA MCP returned malformed HTTP JSON. Response body: ",
        text,
      ),
    );
  }
}

type IdaDiagnosticRedactor = ReturnType<typeof createIdaDiagnosticRedactor>;

type IdaContentType = Readonly<{
  essence: string;
  subtype: string;
  charset: string | undefined;
  parameters: ReadonlyMap<string, string>;
}>;

const httpQuotedOctet = (code: number): boolean =>
  code === 9 ||
  code === 32 ||
  (code >= 33 && code <= 126) ||
  (code >= 128 && code <= 255);

/** Consume one complete RFC 9110 media type; never discard a malformed parameter. */
const parseIdaContentType = (
  text: string,
): Result<IdaContentType, "malformed" | "ambiguous"> => {
  let cursor = 0;
  const token = new RegExp("[!#$%&'*+.^_`|~0-9A-Za-z-]+", "y");
  const readToken = (): string | undefined => {
    token.lastIndex = cursor;
    const match = token.exec(text);
    if (match === null) return undefined;
    cursor = token.lastIndex;
    return match[0];
  };
  const readOws = (): void => {
    while (text[cursor] === " " || text[cursor] === "\t") cursor++;
  };
  const readQuoted = (): string | undefined => {
    cursor++;
    let value = "";
    while (cursor < text.length) {
      let code = text.charCodeAt(cursor++);
      if (code === 34) return value;
      if (code === 92) {
        code = text.charCodeAt(cursor++);
        if (!httpQuotedOctet(code)) return undefined;
      } else if (!httpQuotedOctet(code)) return undefined;
      value += String.fromCharCode(code);
    }
    return undefined;
  };
  readOws();
  const type = readToken()?.toLowerCase();
  if (type === undefined || text[cursor++] !== "/") return err("malformed");
  const subtype = readToken()?.toLowerCase();
  if (subtype === undefined) return err("malformed");
  const parameters = new Map<string, string>();
  let ambiguous = false;
  while (true) {
    readOws();
    if (cursor === text.length) break;
    if (text[cursor++] !== ";") return err("malformed");
    readOws();
    // RFC 9110 parameters admit an empty item after a semicolon.
    if (cursor === text.length || text[cursor] === ";") continue;
    const name = readToken()?.toLowerCase();
    if (name === undefined || text[cursor++] !== "=") return err("malformed");
    const value = text[cursor] === '"' ? readQuoted() : readToken();
    if (value === undefined) return err("malformed");
    // Repetition is ambiguous for this owner, even if both values agree.
    // Keep parsing so syntax errors anywhere in the field cannot be discarded.
    if (parameters.has(name)) ambiguous = true;
    else parameters.set(name, value);
  }
  return ambiguous
    ? err("ambiguous")
    : ok({
        essence: type + "/" + subtype,
        subtype,
        charset: parameters.get("charset"),
        parameters,
      });
};
const httpErrorBody = (
  response: Response,
  text: string,
  redactor: IdaDiagnosticRedactor,
): string => {
  const omitted = redactor.text(
    "IDA MCP response body omitted: unsupported or unknown format or character encoding.",
  );
  const contentType = response.headers.get("content-type");
  if (contentType === null) return omitted;
  const mediaType = parseIdaContentType(contentType);
  if (!mediaType.ok) return omitted;
  const charset = mediaType.value.charset?.toLowerCase();
  if (
    charset !== undefined &&
    !["utf-8", "utf8", "us-ascii", "ascii"].includes(charset)
  )
    return omitted;
  if (
    mediaType.value.subtype === "json" ||
    mediaType.value.subtype.endsWith("+json")
  )
    return redactor.json(text);
  if (mediaType.value.essence === "text/plain") return redactor.text(text);
  return omitted;
};

/** Keep error-body materialization within the diagnostic source-byte budget. */
const readBoundedResponseText = async (
  response: Response,
  responses: ResponseBodyCleanup,
  signal: AbortSignal | null | undefined,
): Promise<string | undefined> => {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let cancellationOwnsReader = false;
  const cancel = (): void => {
    if (cancellationOwnsReader) return;
    cancellationOwnsReader = true;
    responses.cancel(async () => {
      try {
        await reader.cancel(signal?.reason);
      } finally {
        reader.releaseLock();
      }
    });
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) {
        cancel();
        throw signal.reason;
      }
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (done) return Buffer.concat(chunks, total).toString("utf8");
      total += value.byteLength;
      if (total > IDA_DIAGNOSTIC_SOURCE_BYTES) {
        cancel();
        return undefined;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!cancellationOwnsReader) reader.releaseLock();
  }
};

const diagnosticFetch =
  (
    redactor: IdaDiagnosticRedactor,
    responses: ResponseBodyCleanup,
    acquisitions: ArtifactResourceScope,
    stopped: () => boolean,
    rejectTransport: (failure: McpHttpUtf8Error) => void,
  ): typeof fetch =>
  async (input, init) => {
    const beganBeforeStop = !stopped();
    let pending = true;
    const owner: ArtifactResourceOwner = {
      kind: "lease",
      resource: "IDA MCP HTTP response acquisition",
      lease: {
        release: async () => {
          if (pending)
            throw new Error(
              "IDA MCP HTTP response acquisition is still pending",
            );
        },
      },
    };
    acquisitions.retain(owner);
    try {
      const acquired = await fetch(input, init);
      if (init?.signal?.aborted || (beganBeforeStop && stopped())) {
        if (acquired.body !== null)
          responses.cancel(() => acquired.body!.cancel());
        throw (
          init?.signal?.reason ??
          new Error("IDA MCP connection closed before response acquisition")
        );
      }
      const response = validateMcpHttpResponse(acquired, rejectTransport);
      const readText = response.text.bind(response);
      let safeBody: string | undefined;
      if (!response.ok) {
        // Normalize before the SDK can swallow a body-consumer failure or drop
        // its format metadata. Both consumers use this one owned diagnostic.
        const sourceBody = await readBoundedResponseText(
          response,
          responses,
          init?.signal,
        );
        safeBody =
          sourceBody === undefined
            ? redactor.text(
                `IDA MCP response body omitted: exceeds ${IDA_DIAGNOSTIC_SOURCE_BYTES} UTF-8 bytes.`,
              )
            : httpErrorBody(response, sourceBody, redactor);
        const body = safeBody;
        Object.defineProperty(response, "text", {
          value: async (): Promise<string> => body,
        });
      }
      // Successful JSON remains lazy, and SSE keeps its original body stream.
      Object.defineProperty(response, "json", {
        value: async (): Promise<unknown> => {
          const text = safeBody ?? (await readText());
          try {
            const value: unknown = JSON.parse(text);
            return value;
          } catch {
            // Parsing failure owns diagnostics even when the HTTP status succeeded.
            throw new IdaHttpJsonError(
              safeBody ?? httpErrorBody(response, text, redactor),
              redactor,
            );
          }
        },
      });
      return response;
    } finally {
      pending = false;
      await acquisitions.release(owner);
    }
  };

const retainedTransportCause = (cause: unknown, message: string): Error => {
  // Do not clone arbitrary upstream fields, stacks, data or nested causes.
  if (cause instanceof SdkHttpError)
    return new SdkHttpError(cause.code, message, {
      status: cause.data.status,
      statusText: "",
    });
  if (cause instanceof ProtocolError)
    return new ProtocolError(cause.code, message);
  return new Error(message);
};
/** Create a standard SDK connection to an existing upstream registration. */
export const createIdaMcpConnection = (
  config: IdaConfiguration,
  environment: Readonly<NodeJS.ProcessEnv>,
  dependencies: IdaMcpConnectionDependencies,
): IdaMcpConnection => {
  const client = new StructuredContentMcpClient({
    name: "rea-ida-provider",
    version: "1",
  });
  const redactor = (
    dependencies.createDiagnosticRedactor ?? createIdaDiagnosticRedactor
  )(config);
  const responses = new ResponseBodyCleanup("IDA MCP HTTP response body");
  const acquisitions = new ArtifactResourceScope();
  let stopping = false;
  let transportClosed = false;
  let closing: Promise<void> | undefined;
  let stderr = Buffer.alloc(0);
  let stderrBytes = 0;
  let httpUtf8Failure: McpHttpUtf8Error | undefined;
  const capturedTransportOutput = () => {
    let start = 0;
    if (stderrBytes > stderr.length)
      while (start < stderr.length && (stderr[start]! & 0xc0) === 0x80) start++;
    return {
      stdout: "",
      stderr: redactor.blocks([stderr.subarray(start).toString("utf8")]),
      truncated: stderrBytes > stderr.length - start,
      stdout_bytes: 0,
      stderr_bytes: stderrBytes,
    };
  };
  // SDK 2.3.1 returns an SdkError abort reason by identity. A fresh private
  // reason distinguishes this caller abort from an already established failure.
  const requestWithCallerSignal = async <Value>(
    operation: string,
    signal: AbortSignal | undefined,
    request: (requestSignal: AbortSignal | undefined) => Promise<Value>,
  ): Promise<Value> => {
    if (signal === undefined) return request(undefined);
    const controller = new AbortController();
    const cancellation = new SdkError(
      SdkErrorCode.RequestTimeout,
      "REA caller cancelled this IDA MCP request",
    );
    const abort = () => controller.abort(cancellation);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    try {
      return await request(controller.signal);
    } catch (cause: unknown) {
      if (cause === cancellation)
        throw cancelledBy(operation, signal, {
          capturedOutput: capturedTransportOutput(),
        });
      throw cause;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
  const transportFailure = (
    cause: unknown,
    operation = "ida_mcp_response",
    requestTimeoutMs = config.timeoutMs,
  ): never => {
    // The owned transport records the exceeded output ceiling before it closes
    // the connection, so the SDK's closed-request error is not the reason.
    const observed = stdio?.observedFailure();
    const outputLimit =
      observed?.kind === "output_limit" ? observed : undefined;
    if (cause instanceof IdaDiagnosticResourceError) throw cause;
    if (cause instanceof McpHttpUtf8Error) throw cause;
    // The Windows command lookup already classified its own deadline.
    if (cause instanceof AnalysisTimeoutError) throw cause;
    if (
      httpUtf8Failure !== undefined &&
      cause instanceof SdkError &&
      cause.code === SdkErrorCode.ConnectionClosed
    )
      throw httpUtf8Failure;
    let failure: Error;
    if (cause instanceof IdaHttpJsonError)
      failure = new Error(cause.message, { cause });
    else {
      const message =
        cause instanceof Error
          ? cause.message
          : "Unknown IDA MCP transport failure";
      const body = cause instanceof SdkHttpError ? cause.data.text : undefined;
      // Only the pinned SDK POST producer places this owned body at a known
      // span. Equal substrings elsewhere remain untrusted SDK context.
      const prefix = "Error POSTing to endpoint: ";
      const ownedPostBody =
        cause instanceof SdkHttpError &&
        cause.code === SdkErrorCode.ClientHttpNotImplemented &&
        typeof body === "string" &&
        message === prefix + body;
      // Normalized wire headers and supported decoded candidates have no LF.
      // Separating owners prevents their concatenation from spelling a credential.
      const safeMessage = ownedPostBody
        ? redactor.message(prefix, body)
        : redactor.blocks([message]);
      failure = new Error(safeMessage, {
        cause: retainedTransportCause(cause, safeMessage),
      });
    }
    const capturedOutput = capturedTransportOutput();
    if (cause instanceof SdkError && cause.code === SdkErrorCode.RequestTimeout)
      throw new AnalysisTimeoutError(operation, requestTimeoutMs, {
        cause: failure,
        capturedOutput,
        ...idaRegistrationTimeoutGuidance(
          requestTimeoutMs,
          "request",
          config.timeoutMs,
        ),
      });
    if (outputLimit !== undefined) {
      const { limit } = outputLimit.ceiling;
      throw new AnalysisResourceConstraintError(
        operation,
        "transport",
        `Upstream IDA MCP reply exceeded the ${String(limit)}-byte transport limit; no partial Evidence was returned.`,
        { max_response_bytes: limit },
        {
          cause: outputLimit.cause,
          capturedOutput,
          // REA bounds each stdio message at a fixed size with no runtime override.
          retryable: false,
          fixedAllowance: {
            ...outputLimit.ceiling,
            narrowing:
              "Request a smaller result from IDA, such as a narrower address range or fewer items.",
          },
        },
      );
    }
    if (stderrBytes === 0) throw failure;
    throw new ProviderAdapterError("ida", "transport", {
      cause: failure,
      diagnostics: { reason: failure.message },
      capturedOutput,
    });
  };
  // Keep a bounded diagnostic tail for genuine failures; never persist ambient variables.
  const retainStderr = (chunk: unknown): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    stderrBytes += bytes.length;
    const combined = Buffer.concat([stderr, bytes]);
    stderr = Buffer.from(
      combined.subarray(Math.max(0, combined.length - IDA_STDERR_TAIL_BYTES)),
    );
  };
  const transport: OwnedMcpStdioTransport | StreamableHTTPClientTransport =
    "command" in config
      ? new OwnedMcpStdioTransport(
          {
            command: config.command,
            arguments: config.args,
            // Only the selected snapshot reaches the child, never REA's ambient environment.
            hostEnvironment: snapshotEnvironment(
              environment,
              dependencies.platform,
            ),
            env: {
              IDA_MCP_MAX_WORKERS: "1",
              ...snapshotEnvironment(config.env, dependencies.platform),
            },
            // Registrations commonly launch interpreter-driven scripts.
            expectedCommand: null,
          },
          {
            provider: "ida",
            operation: "ida_mcp_close",
            label: "IDA MCP",
            maxFrameBytes:
              dependencies.maxStdioMessageBytes ?? IDA_STDIO_MAX_MESSAGE_BYTES,
            // Upstream servers release IDA databases on end of input; keep the
            // SDK's two-second grace before the owned group is stopped.
            gracefulInputCloseMs: 2_000,
            // IDA keeps its own redacted tail; the supervisor retains none.
            maxDiagnosticBytes: { stdout: 0, stderr: 0 },
            onStderr: retainStderr,
            // Cleanup failures carry the same redacted tail as other transport failures.
            capturedOutput: capturedTransportOutput,
          },
          idaStdioLauncher(
            dependencies.platform,
            dependencies.launcher ?? spawnOwnedProviderProcess,
            config.timeoutMs,
          ),
        )
      : new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: config.headers, redirect: "error" },
          fetch: diagnosticFetch(
            redactor,
            responses,
            acquisitions,
            () => stopping,
            (failure) => {
              httpUtf8Failure ??= failure;
              void transport.close().catch(() => undefined);
            },
          ),
        });
  const stdio =
    transport instanceof OwnedMcpStdioTransport ? transport : undefined;
  return {
    async connect() {
      await client
        .connect(transport, { timeout: config.timeoutMs })
        .catch(async (cause: unknown) => {
          // A launcher can close stdin before its diagnostic reaches stderr.
          // Join the SDK's bounded teardown before taking the diagnostic snapshot.
          if (
            stdio !== undefined &&
            cause instanceof Error &&
            "code" in cause &&
            cause.code === "EPIPE"
          )
            await stdio.close();
          return transportFailure(cause, "ida_mcp_connect");
        });
      const catalog = await client
        .listTools(undefined, {
          timeout: config.timeoutMs,
        })
        .catch((cause: unknown) => transportFailure(cause, "ida_mcp_catalog"));
      return catalog.tools.map(({ name }) => name);
    },
    async call(name, args, options) {
      const requestTimeoutMs = Math.min(
        config.timeoutMs,
        options?.timeoutMs ?? config.timeoutMs,
      );
      return decodeIdaToolResult(
        await requestWithCallerSignal(name, options?.signal, (signal) =>
          client.callTool(
            { name, arguments: args },
            {
              timeout: requestTimeoutMs,
              ...(signal === undefined ? {} : { signal }),
            },
          ),
        ).catch((cause: unknown) => {
          if (cause instanceof AnalysisCancelledError) throw cause;
          return transportFailure(cause, name, requestTimeoutMs);
        }),
        config.protocol === "native" ? "native" : undefined,
        redactor,
      );
    },
    async readResource(uri, options) {
      const response = await requestWithCallerSignal(
        "ida_mcp_read_resource",
        options?.signal,
        (signal) =>
          client.readResource(
            { uri },
            {
              timeout: config.timeoutMs,
              ...(signal === undefined ? {} : { signal }),
            },
          ),
      ).catch((cause: unknown) => {
        if (cause instanceof AnalysisCancelledError) throw cause;
        return transportFailure(cause, "ida_mcp_read_resource");
      });
      return decodeIdaJsonResource(uri, response);
    },
    serverInfo: () => jsonValueSchema.parse(client.getServerVersion() ?? null),
    close() {
      if (closing !== undefined) return closing;
      stopping = true;
      const attempt = (async () => {
        const failures: unknown[] = [];
        if (!transportClosed) {
          try {
            // Owned stdio teardown notifies the SDK client itself and reports
            // incomplete process cleanup as its own ProviderCleanupError.
            if (stdio === undefined)
              await client.close().catch(transportFailure);
            else await stdio.close();
            transportClosed = true;
          } catch (cause: unknown) {
            failures.push(cause);
          }
        }
        for (const resources of [acquisitions, responses]) {
          try {
            await resources.close();
          } catch (cause: unknown) {
            const failure = new ProviderCleanupError(
              "ida",
              resources.cleanupResources,
              { reason: "IDA MCP HTTP response cleanup remains incomplete." },
              { cause, operation: "ida_mcp_close" },
            );
            bindArtifactFileCleanup(cause, failure);
            failures.push(failure);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(
            failures,
            "IDA MCP transport and response cleanup failed",
          );
      })();
      closing = attempt;
      void attempt
        .finally(() => {
          if (closing === attempt) closing = undefined;
        })
        .catch(() => undefined);
      return attempt;
    },
    detach() {
      stdio?.detach();
    },
  };
};

/** Resource metadata follows the SDK's optional media type; content/identity stay strict. */
const decodeIdaJsonResource = (uri: string, response: unknown): JsonValue => {
  const resource = z
    .object({
      contents: z
        .array(
          z.object({
            uri: z.literal(uri),
            mimeType: z
              .string()
              .refine((value) => {
                try {
                  return new MIMEType(value).essence === "application/json";
                } catch {
                  return false;
                }
              }, "Expected a JSON resource media type")
              .optional(),
            text: z.string(),
          }),
        )
        .length(1),
    })
    .parse(response);
  return parseIdaTextReply(resource.contents[0]!.text);
};
