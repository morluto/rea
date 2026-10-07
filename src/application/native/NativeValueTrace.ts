import { functionDossierSchema } from "../../domain/hopperValues.js";
import { nativeCallTargetsSchema } from "../../domain/native/nativeInstruction.js";
import {
  nativeValueTraceInputSchema,
  nativeValueTraceSchema,
} from "../../domain/native/nativeValueTrace.js";
import { createEvidence } from "../../domain/evidence.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { err, ok } from "../../domain/result.js";
import type { AnalysisOperationPort } from "../AnalysisProvider.js";
import type { EnhancedResult } from "../EnhancedToolTypes.js";

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
  const callBindings: {
    caller: string;
    callee: string;
    call: string;
    argument_count: number;
    output: boolean;
    evidence_id: string;
  }[] = [];
  const pending = [{ procedure: input.procedure, depth: 0 }];
  const visited = new Set<string>();
  let targetSha256: string | undefined;
  let truncated = false;
  let decompilations = 0;
  let callSites = 0;
  let bytes = 0;
  while (pending.length > 0) {
    if (signal?.aborted)
      return err(new AnalysisCancelledError("trace_native_values"));
    const next = pending.shift();
    if (next === undefined || visited.has(next.procedure)) continue;
    if (decompilations >= input.max_functions) {
      truncated = true;
      unknowns.push({
        procedure: next.procedure,
        address: null,
        reason: "decompilation budget reached",
      });
      break;
    }
    const execution = await analysis.execute(
      "analyze_function",
      { procedure: next.procedure },
      signal === undefined ? {} : { signal },
    );
    decompilations++;
    if (!execution.ok) {
      if (execution.error._tag === "AnalysisCancelledError")
        return err(execution.error);
      unknowns.push({
        procedure: next.procedure,
        address: null,
        reason: execution.error.message,
      });
      continue;
    }
    const parsed = functionDossierSchema.safeParse(execution.value.result);
    if (!parsed.success || execution.value.subject === null)
      return err(
        new AnalysisOutputError(
          "trace_native_values",
          "Function dossier lacks validated facts or artifact identity",
        ),
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
        ),
      );
    const evidence = createEvidence(
      execution.value.subject,
      execution.value.provider,
      {
        operation: "analyze_function",
        parameters: { procedure: next.procedure },
        result: execution.value.result,
        rawResult: execution.value.rawResult,
        limitations: execution.value.limitations,
        locations: execution.value.locations,
        ...(execution.value.analysisProfile === undefined
          ? {}
          : { analysisProfile: execution.value.analysisProfile }),
      },
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
      const size = Buffer.byteLength(JSON.stringify(node));
      if (nodes.length >= input.max_nodes || bytes + size > 8 * 1024 * 1024) {
        truncated = true;
        break;
      }
      bytes += size;
      ids.add(operation.id);
      nodes.push(node);
    }
    for (const parameter of flow.parameters) {
      if (nodes.length >= input.max_nodes) {
        truncated = true;
        break;
      }
      nodes.push({
        id: `${address}/parameter:${parameter.ordinal}`,
        procedure: address,
        evidence_id: evidenceId,
        kind: "parameter",
        operation: null,
        parameter,
      });
    }
    for (const use of flow.parameter_uses) {
      if (
        !ids.has(use.use) ||
        !nodes.some((node) => node.id === `${address}/parameter:${use.ordinal}`)
      )
        continue;
      if (edges.length >= input.max_edges) {
        truncated = true;
        break;
      }
      edges.push({
        source: `${address}/parameter:${use.ordinal}`,
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
          ),
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
      (nodes.length >= input.max_nodes ||
        edges.length >= input.max_edges ||
        bytes >= 8 * 1024 * 1024)
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
  for (const binding of callBindings) {
    const parameters = nodes.filter(
      (node) => node.procedure === binding.callee && node.kind === "parameter",
    );
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
      for (const node of nodes.filter(
        (node) =>
          node.procedure === binding.callee &&
          node.operation?.opcode === "RETURN" &&
          node.operation.inputs.length > 1,
      )) {
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
      "Traversal caps depth, decompilations, call-site resolutions, nodes, edges and node payloads (8 MiB). Complete serialized output is bounded to 32 MiB. Pagination reruns analysis and returns edges whose source is on the node page; endpoints outside the page retain stable identities.",
    ],
  });
  if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024 * 1024)
    return err(
      new AnalysisOutputError(
        "trace_native_values",
        "Graph output exceeds 32 MiB; lower max_nodes, max_edges or page limit",
      ),
    );
  return ok(result);
};
