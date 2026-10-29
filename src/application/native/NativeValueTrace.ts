import { functionDossierSchema } from "../../domain/native/functionDossier.js";
import { nativeCallTargetsSchema } from "../../domain/native/nativeInstruction.js";
import {
  nativeValueTraceInputSchema,
  nativeValueTraceSchema,
} from "../../domain/native/nativeValueTrace.js";
import { createAnalysisExecutionEvidence } from "../../domain/analysisObservation.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { err, ok } from "../../domain/result.js";
import type { AnalysisOperationPort } from "../AnalysisProvider.js";
import type { EnhancedResult } from "../EnhancedToolTypes.js";
import { jsonParts } from "../../domain/jsonSerialization.js";
import {
  renderSourceLimitations,
  type SourceLimitation,
} from "../SourceLimitations.js";

const NODE_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** Compose bounded high-p-code def-use graphs across exactly referenced call destinations. */
export const traceNativeValues = async (
  analysis: AnalysisOperationPort,
  parameters: unknown,
  signal?: AbortSignal,
): EnhancedResult => {
  const input = nativeValueTraceInputSchema.parse(parameters);
  const nodes: typeof nativeValueTraceSchema._output.nodes = [];
  const edges: typeof nativeValueTraceSchema._output.edges = [];
  const procedures: typeof nativeValueTraceSchema._output.procedures = [];
  const unknowns: typeof nativeValueTraceSchema._output.unknowns = [];
  const sourceLimitations: SourceLimitation[] = [];
  const callBindings: {
    caller: string;
    callee: string;
    call: string;
    argument_count: number;
    output: boolean;
    evidence_id: string;
  }[] = [];
  const pending = [{ procedure: input.procedure, depth: 0 }];
  const attempted = new Set<string>();
  const visited = new Set<string>();
  let targetSha256: string | undefined;
  let truncated = false;
  let decompilations = 0;
  let callSites = 0;
  let bytes = 0;
  let nodeBudgetReached = false;
  const retainNode = (value: (typeof nodes)[number]): boolean => {
    if (nodeBudgetReached) return false;
    if (nodes.length >= input.max_nodes) {
      truncated = true;
      nodeBudgetReached = true;
      return false;
    }
    let size = 0;
    // Reuse bounded JSON encoding to count escapes and UTF-8 expansion
    // before allocating a complete serialized node that might not fit.
    for (const part of jsonParts(value)) {
      size += Buffer.byteLength(part);
      if (size > NODE_PAYLOAD_BYTES - bytes) {
        truncated = true;
        nodeBudgetReached = true;
        return false;
      }
    }
    bytes += size;
    nodes.push(value);
    return true;
  };
  while (pending.length > 0) {
    if (signal?.aborted)
      return err(
        new AnalysisCancelledError("trace_native_values", {
          cause: signal.reason,
        }),
      );
    const next = pending.shift();
    if (
      next === undefined ||
      attempted.has(next.procedure) ||
      visited.has(next.procedure)
    )
      continue;
    if (decompilations >= input.max_functions) {
      truncated = true;
      unknowns.push({
        procedure: next.procedure,
        address: null,
        reason: "decompilation budget reached",
      });
      break;
    }
    // An exact selector is attempted once per trace, even on failure. Only
    // successful dossiers establish canonical procedure identity in visited.
    attempted.add(next.procedure);
    const execution = await analysis.execute(
      "analyze_function",
      { procedure: next.procedure },
      {
        ...(signal === undefined ? {} : { signal }),
        ...(next.depth > 0 ? { selectorOrigin: "provider" as const } : {}),
      },
    );
    decompilations++;
    if (!execution.ok) {
      // A seed failure has no trace to qualify. Preserve the provider's typed
      // refusal; failures after a validated seed remain partial observations.
      if (next.depth === 0 || execution.error._tag === "AnalysisCancelledError")
        return err(execution.error);
      unknowns.push({
        procedure: next.procedure,
        address: null,
        reason: execution.error.message,
      });
      continue;
    }
    const evidence = createAnalysisExecutionEvidence(
      "analyze_function",
      { procedure: next.procedure },
      execution.value,
      "observed",
    );
    const parsed = functionDossierSchema.safeParse(execution.value.result);
    if (!parsed.success || execution.value.subject == null)
      return err(
        new AnalysisOutputError(
          "trace_native_values",
          "Function dossier lacks validated facts or artifact identity",
          parsed.success ? undefined : { cause: parsed.error },
        ).retainPartialObservation(evidence),
      );
    const dossier = parsed.data;
    const address = dossier.procedure.address;
    if (visited.has(address)) continue;
    visited.add(next.procedure);
    visited.add(address);
    targetSha256 ??= execution.value.subject.sha256;
    if (execution.value.subject.sha256 !== targetSha256)
      return err(
        new AnalysisOutputError(
          "trace_native_values",
          "Cross-function target digest mismatch",
        ).retainPartialObservation(evidence),
      );
    const evidenceId = evidence.evidence_id;
    procedures.push({
      address,
      depth: next.depth,
      evidence_id: evidenceId,
      provider: execution.value.provider.id,
      analysis_profile_digest: execution.value.analysisProfile?.digest ?? null,
    });
    const flow = dossier.native_value_flow;
    if (flow === null || !flow.available) {
      unknowns.push({
        procedure: address,
        address: null,
        reason: flow?.reason ?? "Provider has no native def-use model",
      });
      continue;
    }
    if (flow.truncated) {
      truncated = true;
      unknowns.push({
        procedure: address,
        address: null,
        reason: "Provider p-code was truncated",
      });
    }
    const ids = new Set<string>();
    // Keep generated parameter identity independent of which operations fit
    // the budget, while preserving every provider-supplied operation ID.
    const operationIds = new Set(flow.operations.map(({ id }) => id));
    const parameterIds = new Map<number, string>();
    const qualified = (id: string) => `${address}/${id}`;
    for (const operation of flow.operations) {
      if (
        operation.block_membership === "detached" ||
        (operation.block_membership === "unavailable" && operation.is_dead)
      )
        continue;
      const node = {
        id: qualified(operation.id),
        procedure: address,
        evidence_id: evidenceId,
        operation,
        kind: "operation" as const,
        parameter: null,
      };
      if (!retainNode(node)) break;
      ids.add(operation.id);
    }
    for (const parameter of flow.parameters) {
      const parameterId = `parameter:${parameter.ordinal}`;
      let localId = parameterId;
      for (let suffix = 1; operationIds.has(localId); suffix++)
        localId = `${parameterId}#${suffix}`;
      const id = qualified(localId);
      if (
        !retainNode({
          id,
          procedure: address,
          evidence_id: evidenceId,
          kind: "parameter",
          operation: null,
          parameter,
        })
      )
        break;
      parameterIds.set(parameter.ordinal, id);
    }
    for (const use of flow.parameter_uses) {
      const source = parameterIds.get(use.ordinal);
      if (!ids.has(use.use) || source === undefined) continue;
      if (edges.length >= input.max_edges) {
        truncated = true;
        break;
      }
      edges.push({
        source,
        target: qualified(use.use),
        input_index: use.input_index,
        kind: "parameter-use",
        status: "derived",
        evidence_id: evidenceId,
      });
    }
    for (const edge of flow.def_use) {
      if (!ids.has(edge.definition) || !ids.has(edge.use)) continue;
      if (edges.length >= input.max_edges) {
        truncated = true;
        break;
      }
      edges.push({
        source: qualified(edge.definition),
        target: qualified(edge.use),
        input_index: edge.input_index,
        kind: "def-use",
        status: "derived",
        evidence_id: evidenceId,
      });
    }
    for (const operation of flow.operations) {
      if (
        !ids.has(operation.id) ||
        !["CALL", "CALLIND"].includes(operation.opcode)
      )
        continue;
      if (callSites >= input.max_call_sites) {
        truncated = true;
        unknowns.push({
          procedure: address,
          address: operation.address,
          reason: "Call-site resolution budget reached",
        });
        break;
      }
      callSites++;
      const resolved = await analysis.execute(
        "resolve_native_call_targets",
        { address: operation.address },
        signal === undefined ? {} : { signal },
      );
      if (!resolved.ok) {
        if (resolved.error._tag === "AnalysisCancelledError")
          return err(resolved.error);
        unknowns.push({
          procedure: address,
          address: operation.address,
          reason: resolved.error.message,
        });
        continue;
      }
      const targets = nativeCallTargetsSchema.safeParse(resolved.value.result);
      if (!targets.success)
        return err(
          new AnalysisOutputError(
            "resolve_native_call_targets",
            "Invalid static call resolution",
            { cause: targets.error },
          ).retainPartialObservation(
            createAnalysisExecutionEvidence(
              "resolve_native_call_targets",
              { address: operation.address },
              resolved.value,
              "observed",
            ),
          ),
        );
      sourceLimitations.push(
        ...targets.data.limitations.map((limitation) => ({
          provider: resolved.value.provider,
          operation: "resolve_native_call_targets" as const,
          limitation,
        })),
      );
      if (targets.data.targets.length === 0)
        unknowns.push({
          procedure: address,
          address: operation.address,
          reason: `Call target ${targets.data.status}`,
        });
      for (const target of targets.data.targets) {
        if (edges.length >= input.max_edges) {
          truncated = true;
          break;
        }
        const destination = target.procedure ?? target.address;
        edges.push({
          source: qualified(operation.id),
          target: destination,
          input_index: null,
          kind: "call",
          status: target.status,
          evidence_id: evidenceId,
        });
        if (target.status !== "candidate")
          callBindings.push({
            caller: address,
            callee: destination,
            call: qualified(operation.id),
            argument_count: Math.max(0, operation.inputs.length - 1),
            output: operation.output !== null,
            evidence_id: evidenceId,
          });
        if (next.depth < input.max_depth && target.status !== "candidate")
          pending.push({ procedure: destination, depth: next.depth + 1 });
        else if (!visited.has(destination)) {
          truncated = true;
          unknowns.push({
            procedure: address,
            address: operation.address,
            reason:
              target.status === "candidate"
                ? "Ambiguous call candidates were not traversed"
                : "Call depth budget reached",
          });
        }
      }
    }
    if (
      truncated &&
      (nodeBudgetReached ||
        nodes.length >= input.max_nodes ||
        edges.length >= input.max_edges ||
        bytes >= NODE_PAYLOAD_BYTES)
    )
      break;
  }
  if (targetSha256 === undefined)
    return err(
      new AnalysisOutputError(
        "trace_native_values",
        "No seed function could be analyzed",
      ),
    );
  const parametersByProcedure = new Map<string, typeof nodes>();
  const returnsByProcedure = new Map<string, typeof nodes>();
  for (const node of nodes) {
    if (node.kind === "parameter") {
      const parameters = parametersByProcedure.get(node.procedure) ?? [];
      parameters.push(node);
      parametersByProcedure.set(node.procedure, parameters);
    } else if (
      node.operation?.opcode === "RETURN" &&
      node.operation.inputs.length > 1
    ) {
      const returns = returnsByProcedure.get(node.procedure) ?? [];
      returns.push(node);
      returnsByProcedure.set(node.procedure, returns);
    }
  }
  for (const binding of callBindings) {
    const parameters = parametersByProcedure.get(binding.callee) ?? [];
    if (parameters.length === 0)
      unknowns.push({
        procedure: binding.caller,
        address: null,
        reason: `Parameter bindings for ${binding.callee} are unavailable or omitted`,
      });
    for (const node of parameters) {
      const ordinal = node.parameter?.ordinal;
      if (ordinal === undefined || ordinal >= binding.argument_count) {
        unknowns.push({
          procedure: binding.caller,
          address: null,
          reason: `Argument ${ordinal ?? "unknown"} for ${binding.callee} was not recovered`,
        });
        continue;
      }
      if (edges.length >= input.max_edges) {
        truncated = true;
        break;
      }
      edges.push({
        source: binding.call,
        target: node.id,
        input_index: ordinal + 1,
        kind: "argument-binding",
        status: "derived",
        evidence_id: binding.evidence_id,
      });
    }
    if (binding.output)
      for (const node of returnsByProcedure.get(binding.callee) ?? []) {
        if (edges.length >= input.max_edges) {
          truncated = true;
          break;
        }
        edges.push({
          source: node.id,
          target: binding.call,
          input_index: 1,
          kind: "return-binding",
          status: "derived",
          evidence_id: node.evidence_id,
        });
      }
  }
  const page = nodes.slice(input.offset, input.offset + input.limit);
  const pageIds = new Set(page.map(({ id }) => id));
  const result = nativeValueTraceSchema.parse({
    seed: input.procedure,
    target_sha256: targetSha256,
    nodes: page,
    edges: edges.filter(({ source }) => pageIds.has(source)),
    procedures,
    unknowns,
    total_nodes: nodes.length,
    total_edges: edges.length,
    decompilations,
    next_offset:
      input.offset + page.length < nodes.length
        ? input.offset + page.length
        : null,
    truncated: truncated || page.length !== nodes.length,
    limitations: [
      "Static decompiler def-use graphs cover recovered block members; when membership is unavailable they exclude operations marked dead. Logical CALL argument positions bind to recovered HighParam ordinals and RETURN values bind to recovered CALL outputs; these are decompiler-derived dependencies, not original source or runtime observations. Missing parameters, variadic arguments and alias dependencies remain unknown.",
      "LOAD and STORE are memory operations; object fields, persistent state and RNG semantics are not inferred from names or pseudocode.",
      "Traversal caps depth, decompilations, call-site resolutions, nodes, edges and node payloads (8388608 bytes, 8 MiB). This release has no runtime override for the 8388608-byte node-payload allowance. Complete serialized output is bounded to 33554432 bytes (32 MiB) and that output allowance has no runtime override. Pagination reruns analysis and returns edges whose source is on the node page; endpoints outside the page retain stable identities.",
      ...renderSourceLimitations(sourceLimitations),
    ],
  });
  if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024 * 1024)
    return err(
      new AnalysisOutputError(
        "trace_native_values",
        "Graph output exceeds 33554432 bytes (32 MiB). This release has no runtime override. Lower max_nodes, max_edges, or the page limit.",
      ),
    );
  if (signal?.aborted)
    return err(
      new AnalysisCancelledError("trace_native_values", {
        cause: signal.reason,
      }),
    );
  return ok(result);
};
