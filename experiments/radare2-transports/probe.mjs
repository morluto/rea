// Exploratory only: not imported by REA or included in its npm package.
import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isSafeNumber,
  LosslessNumber,
  parse as parseLossless,
} from "lossless-json";
import { z } from "zod";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
} from "../../dist/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../dist/domain/analysisErrorProjection.js";
import { analysisErrorWithCleanupFailure } from "../../dist/domain/analysisErrorCleanup.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../../dist/artifacts/AnalysisCleanupLease.js";
import { observationError } from "./observation-error.mjs";
import { entrypointLifetime } from "./entrypoint-lifetime.mjs";
import { CleanupRetention } from "./cleanup-retention.mjs";
import { err, ok } from "../../dist/domain/result.js";
import {
  jsonValueValidationIssue,
  MAX_JSON_DEPTH,
} from "../../dist/domain/jsonValue.js";
import {
  OwnedCommandFailure,
  ownedCommandResources,
  runOwnedCommand,
} from "../../dist/process/OwnedCommand.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../../dist/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../dist/process/ProcessOwnership.js";
import { DarwinProcessOwnershipInspectionError } from "../../dist/process/DarwinProcessRunTokenReader.js";
import {
  ABORTED,
  waitForAbortable,
} from "../../dist/process/AbortablePromise.js";

// Match the existing reverse-command capture budget; this is not a token budget.
const MAX_BYTES = 16 * 1024 * 1024;
const command = z
  .string()
  .min(1)
  .regex(/^[^\r\n\u0000]+$/u);
const requestSchema = z.strictObject({
  cmd: command,
  json: z.boolean().optional(),
  trim: z.boolean().optional(),
});
const batch = { commands: z.array(z.union([command, requestSchema])).min(1) };
const local = {
  path: z.string().min(1),
  executable: z.string().min(1).optional(),
  settings: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_.]*$/u),
      z.union([
        z.boolean(),
        z.number().finite(),
        z.string().regex(/^[a-zA-Z0-9_.:/ +-]*$/u),
      ]),
    )
    .optional(),
};
export const connectionSchema = z.discriminatedUnion("transport", [
  z.strictObject({ transport: z.literal("exec"), ...local }),
  z.strictObject({ transport: z.literal("r2pipe"), ...local }),
  z.strictObject({ transport: z.literal("r2mcp"), ...local }),
  z.strictObject({
    transport: z.literal("http"),
    endpoint: z.string().url(),
  }),
]);
const inputSchema = z.discriminatedUnion(
  "transport",
  connectionSchema.options.map((schema) => schema.extend(batch)),
);
const retainedOwners = new CleanupRetention();
let probeTail = Promise.resolve();

function retainOwner(owner, lease) {
  return retainedOwners.retain(owner, { lease }).lease;
}

function retainSupervisor(owner, resources) {
  retainOwner(
    owner,
    new AnalysisCleanupLease(async () => {
      const stopped = await owner.stop();
      if (stopped.status === "incomplete") throw new Error(stopped.reason);
    }, resources),
  );
}

function preparationError(failure) {
  const primary = failure.cancellation
    ? new AnalysisCancelledError("radare2_probe", {
        cause: failure.cancellation.reason,
        capturedOutput: failure.capturedOutput,
      })
    : new AnalysisOutputError("radare2_probe", failure.message, {
        cause: failure,
        capturedOutput: failure.capturedOutput,
      });
  const cleanup = failure.cleanupFailure;
  if (!cleanup?.cleanupIncomplete) return primary;
  if (failure.cleanupOwner) {
    const lease = retainOwner(
      failure.cleanupOwner,
      new AnalysisCleanupLease(() => failure.cleanupOwner.close(), {
        get cleanupResources() {
          return cleanup.cleanupResources;
        },
      }),
    );
    lease.bindCleanupError(cleanup);
  }
  return analysisErrorWithCleanupFailure(
    primary,
    cleanup,
    "radare2_probe",
  ).bindCleanupDependencies([primary, cleanup]);
}

function cleanupFailure(primary) {
  const leases = [...retainedOwners.values()].map(({ lease }) => lease);
  const cleanup = new AnalysisOutputError(
    "radare2_probe",
    "Owned provider cleanup remains incomplete",
    {
      cleanup: {
        reason:
          "Cleanup is retried automatically; retryCleanup() can also retry these exact owners",
        resources: leases.flatMap((lease) => lease.cleanupResources),
      },
    },
  );
  new AnalysisCleanupLeaseGroup(cleanup, leases);
  return primary === undefined
    ? cleanup
    : analysisErrorWithCleanupFailure(
        primary,
        cleanup,
        "radare2_probe",
      ).bindCleanupDependencies([primary, cleanup]);
}

/** Retry rather than discard an owner whose cleanup could not be verified. */
export async function retryCleanup() {
  return retainedOwners.retry();
}

function decoded(bytes) {
  const invalid_utf8 = !isUtf8(bytes);
  return {
    text: bytes.toString("utf8"),
    bytes: bytes.length,
    invalid_utf8,
    ...(invalid_utf8 ? { base64: bytes.toString("base64") } : {}),
  };
}

function processObservation(snapshot) {
  if (snapshot == null) return null;
  const { exitCode, signal, ...output } = snapshot;
  return {
    ...output,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
  };
}

function protocolText(output) {
  if (output.invalid_utf8 || output.invalidUtf8)
    throw new AnalysisProtocolError("Protocol JSON contains invalid UTF-8", {
      partialObservation: { raw_reply: output },
    });
  return output.text;
}

// One owner decodes r2pipe2 for every carrier; logs are distinct from process stderr.
const replySchema = z
  .object({
    error: z.boolean(),
    code: z.number().finite(),
    value: z
      .union([
        z.number().finite(),
        z.string().regex(/^(?:-?\d+|0x[\da-f]+)$/iu),
      ])
      .optional(),
    res: z.unknown().optional(),
    logs: z
      .array(
        z
          .object({
            type: z.string(),
            message: z.string(),
            origin: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

// Preserve native strings. Unsafe JSON numbers become exact strings with their
// original type and spelling identified by JSON Pointer, outside the envelope.
function losslessJson(text) {
  const root = { value: parseLossless(text) };
  const numeric_literals = [];
  const pending = [{ owner: root, key: "value", pointer: "", depth: 0 }];
  while (pending.length) {
    const { owner, key, pointer, depth } = pending.pop();
    if (depth > MAX_JSON_DEPTH)
      throw new Error(`JSON exceeds ${MAX_JSON_DEPTH} levels`);
    const value = owner[key];
    if (value instanceof LosslessNumber) {
      if (isSafeNumber(value.value)) owner[key] = Number(value.value);
      else {
        owner[key] = value.value;
        numeric_literals.push({
          pointer,
          producer_type: "json-number",
          literal: value.value,
        });
      }
    } else if (value !== null && typeof value === "object") {
      for (const child of Object.keys(value)) {
        const escaped = child.replaceAll("~", "~0").replaceAll("/", "~1");
        pending.push({
          owner: value,
          key: child,
          pointer: `${pointer}/${escaped}`,
          depth: depth + 1,
        });
      }
    }
  }
  return { value: root.value, numeric_literals };
}

function r2pipe2Reply(output) {
  const text = protocolText(output);
  let reply;
  let numeric_literals;
  try {
    ({ value: reply, numeric_literals } = losslessJson(text));
  } catch (cause) {
    throw new AnalysisProtocolError(
      "Malformed r2pipe2 JSON; command was not retried",
      {
        cause,
        partialObservation: { raw_reply: text },
      },
    );
  }
  const issue = jsonValueValidationIssue(reply);
  if (issue !== undefined || !replySchema.safeParse(reply).success)
    throw new AnalysisProtocolError("Invalid r2pipe2 envelope", {
      partialObservation: { raw_reply: text },
    });
  const r2pipe2 = {
    ...reply,
    command_outcome:
      reply.error ||
      reply.code !== 0 ||
      reply.logs?.some((log) => ["ERROR", "FATAL"].includes(log.type))
        ? "reported_error"
        : "no_error_reported",
  };
  return {
    r2pipe2,
    ...(numeric_literals.length ? { numeric_literals } : {}),
  };
}

const encode = (command) =>
  JSON.stringify(
    typeof command === "string"
      ? { cmd: command, json: false, trim: false }
      : command,
  );

/** Continuously drain the protocol stream, including after a decoder rejects a frame. */
function frames(stream, separator) {
  let parts = [];
  let size = 0;
  let queuedBytes = 0;
  const queue = [];
  let waiting;
  let failure;
  const partial = () => ({
    unterminated_frame: decoded(Buffer.concat(parts, size)),
  });
  const fail = (cause) => {
    failure ??= cause;
    waiting?.reject(failure);
    waiting = undefined;
  };
  stream.on("data", (chunk) => {
    if (failure) return;
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(separator, offset);
      const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
      if (size + part.length + queuedBytes > MAX_BYTES || queue.length >= 16) {
        fail(
          new AnalysisResourceConstraintError(
            "radare2_probe",
            "transport",
            "Provider frame queue exceeds capture budget",
            { max_bytes: MAX_BYTES, max_pending_frames: 16 },
            { partialObservation: partial() },
          ),
        );
        return;
      }
      parts.push(part);
      size += part.length;
      if (end < 0) break;
      const bytes = Buffer.concat(parts, size);
      if (waiting) {
        waiting.accept(bytes);
        waiting = undefined;
      } else {
        queue.push(bytes);
        queuedBytes += size;
      }
      parts = [];
      size = 0;
      offset = end + 1;
    }
  });
  stream.on("error", fail);
  stream.once("end", () =>
    fail(
      new AnalysisProtocolError("Provider exited before the next frame", {
        partialObservation: partial(),
      }),
    ),
  );
  return {
    next: (signal) => {
      const interrupted = () =>
        new AnalysisCancelledError("radare2_probe", {
          cause: signal.reason,
          partialObservation: partial(),
        });
      if (signal.aborted) return Promise.reject(interrupted());
      const bytes = queue.shift();
      if (bytes !== undefined) {
        queuedBytes -= bytes.length;
        return Promise.resolve(bytes);
      }
      if (failure) return Promise.reject(failure);
      return new Promise((accept, reject) => {
        const abort = () => fail(interrupted());
        const settle = (callback) => (value) => {
          signal.removeEventListener("abort", abort);
          callback(value);
        };
        waiting = { accept: settle(accept), reject: settle(reject) };
        signal.addEventListener("abort", abort, { once: true });
      });
    },
  };
}

function send(stream, value, signal) {
  const cancelled = () =>
    new AnalysisCancelledError("radare2_probe", { cause: signal.reason });
  if (signal.aborted) throw cancelled();
  return new Promise((accept, reject) => {
    const finish = (error) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else accept();
    };
    const abort = () => finish(cancelled());
    signal.addEventListener("abort", abort, { once: true });
    try {
      stream.write(value + "\n", finish);
    } catch (cause) {
      finish(cause);
    }
  });
}

async function withOwned(
  executable,
  args,
  environment,
  signal,
  record,
  operation,
) {
  let launched;
  try {
    launched = await spawnOwnedProviderProcess({
      command: executable,
      arguments: args,
      runId: randomUUID(),
      hostEnvironment: environment,
      stdin: "pipe",
      signal,
    });
  } catch (cause) {
    // This launch boundary can reject with throwIfAborted's raw reason before
    // returning an owner. A caller's typed error does not transfer ownership.
    if (signal.aborted && cause === signal.reason)
      throw new AnalysisCancelledError("radare2_probe", { cause });
    throw cause;
  }
  const owner = new ProviderProcessSupervisor(
    {
      ...launched,
      ownsProcessLifetime: true,
      cleanup:
        launched.cleanup ??
        (() => cleanupOwnedProcessGroup(launched.ownership)),
    },
    { captureStdout: false, maxDiagnosticBytes: MAX_BYTES },
  );
  // Write callbacks report their errors; also consume the stream's error event.
  launched.process.stdin.on("error", () => {});
  let result;
  let failure;
  try {
    result = await operation(launched.process);
  } catch (cause) {
    failure = cause;
  }
  launched.process.stdin.end();
  await owner.waitForExit(1_000);
  const stopped = await owner.stop();
  if (stopped.status === "incomplete") {
    if (failure === undefined && signal.aborted)
      failure = new AnalysisCancelledError("radare2_probe", {
        cause: signal.reason,
      });
    retainSupervisor(owner, ownedCommandResources(launched.ownership));
    throw cleanupFailure(
      observationError(
        failure,
        "radare2_probe",
        "Owned provider cleanup remains incomplete",
        {
          cleanup: stopped,
          diagnostics: processObservation(owner.snapshot()),
          primary_failure: failure?.message ?? null,
        },
      ),
    );
  }
  try {
    record({ provider_diagnostics: processObservation(owner.snapshot()) });
  } catch (cause) {
    failure ??= cause;
  }
  if (failure !== undefined) throw failure;
  return result;
}

function httpEndpoint(source) {
  const url = new URL(source);
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.hash ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new AnalysisInputError("radare2_probe");
  // Pin localhost to loopback while retaining the caller's original URL below.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url;
}

async function httpCommand(endpoint, command, signal, authorization) {
  return new Promise((accept, reject) => {
    let snapshot;
    let settled = false;
    const fail = (cause) => {
      if (settled) return;
      settled = true;
      reject(
        observationError(
          cause.code === "ABORT_ERR" && signal.aborted
            ? new AnalysisCancelledError("radare2_probe", {
                cause: signal.reason,
              })
            : cause,
          "radare2_probe",
          "HTTP command completion is unknown; do not retry automatically",
          snapshot?.(),
        ),
      );
    };
    // r2 6.2.5 emits LF-only headers. Use Node's format-aware compatibility parser.
    // This is restricted to an explicit loopback peer and never follows redirects.
    const request = httpRequest(
      endpoint,
      {
        method: "POST",
        signal,
        insecureHTTPParser: true,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": Buffer.byteLength(command),
          ...(authorization === undefined
            ? {}
            : { Authorization: authorization }),
        },
      },
      (response) => {
        const parts = [];
        let size = 0;
        snapshot = () => ({
          status: response.statusCode,
          output: decoded(Buffer.concat(parts, size)),
        });
        response.on("data", (bytes) => {
          if (size + bytes.length > MAX_BYTES) {
            response.destroy(
              new AnalysisResourceConstraintError(
                "radare2_probe",
                "transport",
                "HTTP response exceeds 16 MiB",
                { max_bytes: MAX_BYTES },
              ),
            );
            return;
          }
          parts.push(bytes);
          size += bytes.length;
        });
        response.once("error", fail);
        response.once("end", () => {
          if (settled) return;
          settled = true;
          accept({ ...snapshot(), headers: response.rawHeaders });
        });
      },
    );
    request.once("error", fail);
    request.end(command);
  });
}

// Resolve required names once, then validate calls against those exact schemas.
// Unknown dialects/references and ambiguous names fail before tool dispatch.
function bindMcpTools(catalog) {
  if (!Array.isArray(catalog?.tools))
    throw new AnalysisProtocolError(
      "MCP tool catalog must contain a tools array",
    );
  const validator = new Ajv2020({ strict: false, validateFormats: false });
  const contracts = new Map();
  for (const name of ["open_file", "run_command"]) {
    const matches = catalog.tools.filter((tool) => tool?.name === name);
    if (matches.length !== 1)
      throw new AnalysisProtocolError(
        `Expected one named MCP contract for ${name}`,
      );
    const schema = matches[0].inputSchema;
    if (!schema || schema.type !== "object")
      throw new AnalysisProtocolError(
        `MCP input contract must be an object schema: ${name}`,
      );
    try {
      contracts.set(name, {
        validate: validator.compile(schema),
        properties: schema.properties ?? {},
      });
    } catch (cause) {
      throw new AnalysisProtocolError(
        `Invalid or unsupported MCP input schema: ${name}`,
        { cause },
      );
    }
  }
  return contracts;
}

/** Observe a sequential batch. Results are protocol observations, not REA Evidence. */
export async function probe(input, options = {}) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return err(new AnalysisInputError("radare2_probe"));
  const selected = parsed.data;
  const environment = { ...(options.environment ?? process.env) };
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 120_000),
    ...(options.signal === undefined ? [] : [options.signal]),
  ]);
  const pending = waitForAbortable(probeTail, signal).then((ready) =>
    ready === ABORTED
      ? err(
          new AnalysisCancelledError("radare2_probe", { cause: signal.reason }),
        )
      : observeBatch(selected, { ...options, environment, signal }),
  );
  // A cancelled waiter can settle immediately, but cannot release an earlier
  // active batch's admission to the next caller.
  probeTail = Promise.all([probeTail, pending]).then(
    () => {},
    () => {},
  );
  return pending;
}

async function observeBatch(selected, options) {
  const { environment, signal } = options;
  const transcript = [];
  let observedBytes = 0;
  const record = (value) => {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (observedBytes + bytes > MAX_BYTES)
      throw new AnalysisResourceConstraintError(
        "radare2_probe",
        "transport",
        "Batch transcript exceeds 16 MiB",
        { max_bytes: MAX_BYTES },
      );
    observedBytes += bytes;
    transcript.push(value);
  };
  try {
    if (await retryCleanup()) throw cleanupFailure();
    if (signal.aborted)
      throw new AnalysisCancelledError("radare2_probe", {
        cause: signal.reason,
      });
    if (selected.transport === "http") {
      const endpoint = httpEndpoint(selected.endpoint);
      for (const command of selected.commands) {
        const reply = await httpCommand(
          endpoint,
          encode(command),
          signal,
          options.authorization,
        );
        record({ command, ...reply });
        if (reply.status < 200 || reply.status >= 300)
          throw new AnalysisProtocolError(
            "HTTP command returned an unsuccessful status",
          );
        record({ command, ...r2pipe2Reply(reply.output) });
      }
    } else {
      const path = resolve(selected.path);
      const executable =
        selected.executable ??
        (selected.transport === "r2mcp"
          ? (environment.REA_R2MCP_COMMAND ?? "r2mcp")
          : (environment.REA_R2_COMMAND ?? "r2"));
      const flags = ["-N", "-q", "-e", "scr.color=0", "-e", "scr.utf8=0"];
      const settings = Object.entries(selected.settings ?? {});
      for (const [key, value] of settings) flags.push("-e", `${key}=${value}`);
      if (selected.transport === "exec") {
        for (const command of selected.commands) {
          const output = await runOwnedCommand(
            {
              command: executable,
              arguments: [...flags, "-c", encode(command), path],
              runId: randomUUID(),
              hostEnvironment: environment,
            },
            {
              timeoutMs: options.timeoutMs ?? 120_000,
              diagnosticBytes: MAX_BYTES,
            },
            {
              signal,
            },
          );
          record({ command, output });
          record({ command, ...r2pipe2Reply(output.stdout) });
        }
      } else {
        const args =
          selected.transport === "r2pipe"
            ? [...flags, "-0", path]
            : [
                "-r",
                "-N",
                "-c",
                [
                  "e scr.color=0",
                  "e scr.utf8=0",
                  ...settings.map(([key, value]) => `e ${key}=${value}`),
                ].join(";"),
              ];
        await withOwned(
          executable,
          args,
          environment,
          signal,
          record,
          async (child) => {
            const iterator = frames(
              child.stdout,
              selected.transport === "r2pipe" ? 0 : 10,
            );
            const write = (value) => send(child.stdin, value, signal);
            if (selected.transport === "r2pipe") {
              const startup = await iterator.next(signal);
              if (startup.length) record({ startup: decoded(startup) });
              for (const command of selected.commands) {
                await write(encode(command));
                const output = decoded(await iterator.next(signal));
                record({ command, output });
                record({ command, ...r2pipe2Reply(output) });
              }
            } else {
              let id = 0;
              const rpc = async (method, params) => {
                const requestId = ++id;
                const request = {
                  jsonrpc: "2.0",
                  id: requestId,
                  method,
                  params,
                };
                record({ mcp_request: request });
                await write(JSON.stringify(request));
                for (;;) {
                  const raw = decoded(await iterator.next(signal));
                  record({ request_id: requestId, mcp_frame: raw });
                  const text = protocolText(raw);
                  let reply;
                  let numeric_literals;
                  try {
                    const decoded = losslessJson(text);
                    reply = decoded.value;
                    numeric_literals = decoded.numeric_literals;
                  } catch (cause) {
                    throw new AnalysisProtocolError("Malformed MCP JSON", {
                      cause,
                      partialObservation: { raw_reply: raw },
                    });
                  }
                  record({
                    request_id: requestId,
                    mcp_envelope: reply,
                    ...(numeric_literals.length
                      ? { mcp_numeric_literals: numeric_literals }
                      : {}),
                  });
                  if (!reply || reply.jsonrpc !== "2.0")
                    throw new AnalysisProtocolError("Malformed MCP reply");
                  if (
                    reply.id === undefined &&
                    typeof reply.method === "string"
                  )
                    continue;
                  if (reply.id !== requestId)
                    throw new AnalysisProtocolError(
                      "MCP response identity mismatch",
                    );
                  if (reply.error)
                    throw new AnalysisProtocolError("MCP request failed", {
                      partialObservation: reply,
                    });
                  if (!Object.hasOwn(reply, "result"))
                    throw new AnalysisProtocolError("MCP result missing");
                  return reply.result;
                }
              };
              await rpc("initialize", {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: {
                  name: "rea-radare2-transport-probe",
                  version: "0",
                },
              });
              const initialized = {
                jsonrpc: "2.0",
                method: "notifications/initialized",
              };
              record({ mcp_request: initialized });
              await write(JSON.stringify(initialized));
              const catalog = await rpc("tools/list", {});
              const contracts = bindMcpTools(catalog);
              const call = async (name, arguments_) => {
                if (!contracts.get(name)?.validate(arguments_))
                  throw new AnalysisProtocolError(
                    `Arguments do not satisfy the named MCP contract: ${name}`,
                  );
                const reply = await rpc("tools/call", {
                  name,
                  arguments: arguments_,
                });
                if (reply.isError === true)
                  throw new AnalysisProtocolError("r2mcp tool failed");
                return reply;
              };
              await call("open_file", { file_path: path });
              const properties = contracts.get("run_command").properties;
              for (const command of selected.commands) {
                const reply = await call("run_command", {
                  command: encode(command),
                  ...(properties?.page_size ? { page_size: 10_000 } : {}),
                });
                const text = reply.content?.filter(
                  (block) => block.type === "text",
                );
                if (text?.length !== 1 || typeof text[0].text !== "string")
                  throw new AnalysisProtocolError(
                    "r2mcp did not return one text block; raw result retained",
                  );
                record({ command, ...r2pipe2Reply({ text: text[0].text }) });
              }
            }
          },
        );
      }
    }
    const observation = {
      transport: selected.transport,
      input: selected,
      transcript,
      target_identity: "unverified",
      completion: "responses_received",
      cleanup:
        selected.transport === "http" ? "external_session_unowned" : "complete",
    };
    if (signal.aborted)
      return err(
        new AnalysisCancelledError("radare2_probe", {
          cause: signal.reason,
          partialObservation: {
            ...observation,
            cleanup_owners_retained: retainedOwners.size,
          },
        }),
      );
    return ok(observation);
  } catch (cause) {
    if (cause instanceof OwnedCommandFailure && cause.cleanupOwner)
      retainSupervisor(cause.cleanupOwner, cause.resources);
    const preparation =
      cause instanceof OwnedCommandFailure
        ? cause.preparationFailure
        : cause instanceof DarwinProcessOwnershipInspectionError
          ? cause
          : undefined;
    const preparedFailure =
      preparation === undefined ? undefined : preparationError(preparation);
    const partialObservation = {
      transport: selected.transport,
      transcript,
      provider_partial: processObservation(cause?.snapshot),
      failure: {
        tag: cause?._tag ?? cause?.name ?? "unknown",
        message: cause?.message ?? "unknown",
      },
      cleanup_owners_retained: retainedOwners.size,
      completion: "unknown",
    };
    let primary = preparedFailure ?? cause;
    if (cause instanceof OwnedCommandFailure && preparedFailure === undefined) {
      if (
        cause.cancellation &&
        (cause.reason === "cancelled" ||
          (cause.cleanupOwner && cause.cause === undefined))
      )
        primary = new AnalysisCancelledError("radare2_probe", {
          cause: cause.cancellation.reason,
        });
      else if (cause.reason === "output-limit")
        primary = new AnalysisResourceConstraintError(
          "radare2_probe",
          "transport",
          cause.message,
          { max_bytes: MAX_BYTES },
          { cause },
        );
    }
    const failure = observationError(
      primary,
      "radare2_probe",
      "Transport probe failed; command effects may be incomplete",
      partialObservation,
    );
    return err(
      cause instanceof OwnedCommandFailure && cause.cleanupOwner
        ? cleanupFailure(failure)
        : failure,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lifetime = entrypointLifetime();
  let input;
  try {
    input = JSON.parse(process.argv[2] ?? "null");
  } catch {
    input = null;
  }
  const result = await probe(input, { signal: lifetime.signal });
  console.log(
    JSON.stringify(
      result.ok
        ? result
        : { ok: false, error: projectAnalysisError(result.error) },
    ),
  );
  if (!result.ok) process.exitCode ||= 1;
}
