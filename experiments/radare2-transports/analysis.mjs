// Isolated analyst-capability prototype. Not a registered REA provider or Evidence writer.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../dist/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../dist/domain/analysisErrorProjection.js";
import { observationError } from "./observation-error.mjs";
import { entrypointLifetime } from "./entrypoint-lifetime.mjs";
import { err, ok } from "../../dist/domain/result.js";
import { connectionSchema, probe } from "./probe.mjs";
import {
  address,
  decodeGraph,
  decodeRecoveredTypes,
  decodeStructLayout,
  functionInputSchema,
  object,
  requireReply,
  traceInputSchema,
  typeInputSchema,
} from "./analysis-values.mjs";
import { decodeEsil, decodeHighPcode, traceFlow } from "./analysis-flow.mjs";
import { sliceNativeEsil } from "./native-esil.mjs";
import { digestTarget, readNativeBytes } from "./native-bytes.mjs";

export {
  addressSchema,
  functionInputSchema,
  traceInputSchema,
  typeInputSchema,
  typeNameSchema,
} from "./analysis-values.mjs";
const OPERATION = "radare2_analysis_experiment";

function failure(cause, message, partialObservation) {
  return err(observationError(cause, OPERATION, message, partialObservation));
}

function cancellation(cause, partialObservation) {
  return new AnalysisCancelledError(OPERATION, {
    cause,
    partialObservation,
  });
}

function createRetention(maximumBytes, transport) {
  const records = new Map();
  let usedBytes = 0;
  return {
    add(kind, observation) {
      try {
        const bytes = Buffer.byteLength(JSON.stringify(observation));
        if (bytes + usedBytes > maximumBytes)
          throw new AnalysisResourceConstraintError(
            OPERATION,
            "capacity",
            "Retained observation capacity reached; release observations before more work",
            {
              observed_bytes: bytes,
              retained_bytes: usedBytes,
              maximum_bytes: maximumBytes,
            },
          );
        const observation_id = randomUUID();
        records.set(observation_id, { observation, bytes });
        usedBytes += bytes;
        return ok({
          observation_id,
          kind,
          target: observation.target,
          transport,
          observation_kind: "experimental-not-REA-Evidence",
          result: observation.result,
        });
      } catch (cause) {
        return failure(cause, "Observation retention failed", observation);
      }
    },
    view(id, section = "result") {
      const record = records.get(id);
      return !record || !["result", "raw", "input", "target"].includes(section)
        ? err(new AnalysisInputError(OPERATION))
        : ok(record.observation[section]);
    },
    release(id) {
      const record = records.get(id);
      if (record) usedBytes -= record.bytes;
      return records.delete(id);
    },
  };
}

function functionCommands(selected, transport) {
  const at = address(selected.procedure);
  const setup = (index) =>
    selected.analysis === "function" && (index === 0 || transport === "exec")
      ? `af @ ${at};`
      : "";
  const commands = ["agfj", "afsj", "afvj"].map((cmd, index) => ({
    cmd: `${setup(index)}${cmd} @ ${at}`,
    json: true,
  }));
  const append = (cmd, json) =>
    commands.push({ cmd: `${setup(commands.length)}${cmd} @ ${at}`, json });
  if (selected.decompiler !== "none")
    append(selected.decompiler === "r2ghidra" ? "pdg" : "pdc", false);
  if (["r2ghidra", "both"].includes(selected.value_flow)) append("pdgx", false);
  if (selected.recover_types) append("aftsj", true);
  return commands;
}

function decodeFunction(selected, replies) {
  const result = decodeGraph(requireReply(replies, 0));
  if (result.procedure.address !== address(selected.procedure))
    throw new Error("Native function identity differs from selected entry");
  const signature = requireReply(replies, 1);
  if (!object(signature)) throw new Error("Missing native function signature");
  result.signature = {
    provenance: "radare2-afsj",
    status: "analysis-database-observation",
    type_origin: "unknown",
    value: signature,
    limitations: [
      "Native inferred types may disagree with the decompiler and original C signature.",
    ],
  };
  result.variables = {
    provenance: "radare2-afvj",
    value: requireReply(replies, 2),
  };
  let next = 3;
  result.pseudocode =
    selected.decompiler === "none"
      ? null
      : { producer: selected.decompiler, text: requireReply(replies, next++) };
  if (["r2ghidra", "both"].includes(selected.value_flow))
    result.high_pcode = decodeHighPcode(requireReply(replies, next++), result);
  if (selected.recover_types)
    result.recovered_types = decodeRecoveredTypes(requireReply(replies, next));
  result.esil = ["esil", "both"].includes(selected.value_flow)
    ? decodeEsil(result)
    : null;
  return result;
}

// Queue ownership remains held until active cancellation and provider cleanup settle.
// A request cancelled before its turn can return promptly without ever starting it.
function serialOperations(options) {
  let tail = Promise.resolve();
  return (operation) =>
    (input, request = {}) => {
      const signal = AbortSignal.any([
        AbortSignal.timeout(options.timeoutMs ?? 120_000),
        ...[options.signal, request.signal].filter(Boolean),
      ]);
      return new Promise((resolve) => {
        let started = false;
        let cancelled = false;
        const abort = () => {
          if (started) return;
          cancelled = true;
          resolve(err(cancellation(signal.reason)));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
        const next = tail.then(async () => {
          if (cancelled) return;
          started = true;
          try {
            resolve(await operation(input, { ...request, signal }));
          } catch (cause) {
            resolve(
              signal?.aborted
                ? err(cancellation(signal.reason))
                : failure(cause, "Experiment operation failed"),
            );
          } finally {
            signal?.removeEventListener("abort", abort);
          }
        });
        tail = next.catch(() => {});
      });
    };
}

function createObserver(connection, options) {
  async function digest(signal) {
    if (connection.transport === "http") return null;
    return digestTarget(connection.path, signal);
  }

  async function observe(commands, request) {
    const { signal } = request;
    let observation;
    try {
      if (signal?.aborted) throw cancellation(signal.reason);
      const before = await digest(signal);
      const prefix = options.prelude ?? [];
      const selected =
        connection.transport === "exec"
          ? commands.map((command) => ({
              ...command,
              cmd: [...prefix, command.cmd].join(";"),
            }))
          : [...prefix.map((cmd) => ({ cmd, json: false })), ...commands];
      const result = await probe(
        { ...connection, commands: selected },
        { ...options, signal },
      );
      if (!result.ok) return result;
      const replies = result.value.transcript
        .filter((entry) => entry.r2pipe2)
        .map((entry) => entry.r2pipe2);
      observation = {
        raw: result.value,
        replies:
          connection.transport === "exec"
            ? replies
            : replies.slice(prefix.length),
        target: {
          path: connection.path ?? null,
          endpoint: connection.endpoint ?? null,
          sha256_before: before,
          sha256_after: null,
          core_binding:
            connection.transport === "http"
              ? "unverified-external-core"
              : "owned-process-opened-selected-path",
        },
      };
      observation.target.sha256_after = await digest(signal);
      if (before !== observation.target.sha256_after)
        return err(
          new AnalysisArtifactChangedError(
            OPERATION,
            connection.path,
            "Target changed during observation",
            { partialObservation: observation },
          ),
        );
      if (
        connection.transport !== "exec" &&
        replies
          .slice(0, prefix.length)
          .some((reply) => reply.command_outcome !== "no_error_reported")
      )
        return failure(
          null,
          "Caller-selected analysis prelude failed",
          observation,
        );
      return ok(observation);
    } catch (cause) {
      return failure(cause, "Observation failed", observation);
    }
  }

  return observe;
}

function createTrace(analyze, observe, retained) {
  return async function trace(input, request) {
    const parsed = traceInputSchema.safeParse(input);
    if (!parsed.success) return err(new AnalysisInputError(OPERATION));
    if (parsed.data.ir === "esil") {
      const { ir: _ir, ...sliceInput } = parsed.data;
      const sliced = await sliceNativeEsil(sliceInput, (commands) =>
        observe(commands, request),
      );
      if (!sliced.ok) return sliced;
      return retained.add("trace_native_values", sliced.value);
    }
    const { parameter, max_nodes, ir: _ir, ...functionInput } = parsed.data;
    const observed = await analyze(functionInput, request);
    if (!observed.ok) return observed;
    const parent_observation_id = observed.value.observation_id;
    try {
      const result = traceFlow(
        observed.value.result.high_pcode,
        observed.value.result.procedure,
        { parameter, max_nodes },
      );
      const reference = retained.add("trace_native_values", {
        input: parsed.data,
        target: observed.value.target,
        result,
        raw: {
          parent_observation_id,
          derivation: "forward traversal of producer varnode def-use edges",
        },
      });
      return reference.ok
        ? ok({ ...reference.value, parent_observation_id })
        : reference;
    } catch (cause) {
      return failure(
        cause,
        "Trace failed; parent observation remains accessible",
        { parent_observation_id },
      );
    }
  };
}

/** Own the target observation, serialized work, and retained experimental facts. */
export function createAnalysisExperiment(inputConnection, options = {}) {
  const connection = connectionSchema.parse(inputConnection);
  const retained = createRetention(
    options.maxRetainedBytes ?? 64 * 1024 * 1024,
    connection.transport,
  );
  const serial = serialOperations(options);
  const observe = createObserver(connection, options);

  async function analyze(input, request) {
    const parsed = functionInputSchema.safeParse(input);
    if (!parsed.success) return err(new AnalysisInputError(OPERATION));
    const observed = await observe(
      functionCommands(parsed.data, connection.transport),
      request,
    );
    if (!observed.ok) return observed;
    try {
      if (request.signal?.aborted) throw cancellation(request.signal.reason);
      const { replies, target, raw } = observed.value;
      const result = decodeFunction(parsed.data, replies);
      const observation = { input: parsed.data, target, result, raw };
      return retained.add("analyze_function", observation);
    } catch (cause) {
      return request.signal?.aborted
        ? err(cancellation(request.signal.reason, observed.value))
        : failure(cause, "Cannot interpret native function result", {
            ...observed.value,
            interpretation_failure: cause?.message ?? "unknown",
          });
    }
  }

  async function inspectType(input, request) {
    const parsed = typeInputSchema.safeParse(input);
    if (!parsed.success) return err(new AnalysisInputError(OPERATION));
    const observed = await observe(
      [{ cmd: `tsj ${parsed.data.type}`, json: true }],
      request,
    );
    if (!observed.ok) return observed;
    try {
      const { replies, target, raw } = observed.value;
      const result = decodeStructLayout(
        requireReply(replies, 0),
        parsed.data.type,
      );
      const observation = { input: parsed.data, target, raw, result };
      return retained.add("inspect_native_data_type", observation);
    } catch (cause) {
      return failure(
        cause,
        "Cannot interpret native type result",
        observed.value,
      );
    }
  }

  async function readBytes(input, request) {
    const observed = await readNativeBytes(
      input,
      (commands) => observe(commands, request),
      connection.path,
      request,
    );
    return observed.ok ? retained.add("read_bytes", observed.value) : observed;
  }

  return {
    analyze: serial(analyze),
    inspectType: serial(inspectType),
    readBytes: serial(readBytes),
    trace: serial(createTrace(analyze, observe, retained)),
    view: retained.view,
    release: retained.release,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lifetime = entrypointLifetime();
  const input = JSON.parse(process.argv[2] ?? "null");
  const experiment = createAnalysisExperiment(input.connection, {
    prelude: input.prelude,
    signal: lifetime.signal,
  });
  const operation = {
    analyze_function: experiment.analyze,
    inspect_native_data_type: experiment.inspectType,
    read_bytes: experiment.readBytes,
    trace_native_values: experiment.trace,
  }[input.operation];
  const result = operation
    ? await operation(input.arguments)
    : err(new AnalysisInputError(OPERATION));
  console.log(
    JSON.stringify(
      result.ok
        ? result
        : { ok: false, error: projectAnalysisError(result.error) },
    ),
  );
  if (!result.ok) process.exitCode ||= 1;
}
