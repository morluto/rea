import type { z } from "zod";
import type { nativeValueTraceSchema } from "../../domain/native/nativeValueTrace.js";
import type { createValueTraceBudget } from "./NativeValueTraceBudget.js";

type Trace = z.output<typeof nativeValueTraceSchema>;

/** Retained caller facts; callee remains the exact selector reported by resolution. */
export interface NativeValueTraceCall {
  readonly caller: string;
  readonly callee: string;
  readonly call: string;
  readonly address: string;
  readonly argument_count: number;
  readonly output: boolean;
  readonly evidence_id: string;
}

/** Bind retained graph rows through procedure identities established by analyzed dossiers. */
export const bindNativeValueTraceCalls = ({
  budget,
  calls,
  procedureAddresses,
  unknowns,
}: {
  readonly budget: ReturnType<typeof createValueTraceBudget>;
  readonly calls: readonly NativeValueTraceCall[];
  readonly procedureAddresses: ReadonlyMap<string, string>;
  readonly unknowns: Trace["unknowns"];
}): void => {
  const parametersByProcedure = new Map<string, Trace["nodes"]>();
  const returnsByProcedure = new Map<string, Trace["nodes"]>();
  for (const node of budget.nodes) {
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
  for (const binding of calls) {
    const callee = procedureAddresses.get(binding.callee);
    const parameters =
      callee === undefined ? [] : (parametersByProcedure.get(callee) ?? []);
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
      if (
        !budget.retainEdge(
          {
            source: binding.call,
            target: node.id,
            input_index: ordinal + 1,
            kind: "argument-binding",
            status: "derived",
            evidence_id: binding.evidence_id,
          },
          binding.caller,
        )
      )
        break;
    }
    if (binding.output)
      for (const node of callee === undefined
        ? []
        : (returnsByProcedure.get(callee) ?? [])) {
        if (
          !budget.retainEdge(
            {
              source: node.id,
              target: binding.call,
              input_index: 1,
              kind: "return-binding",
              status: "derived",
              evidence_id: node.evidence_id,
            },
            binding.caller,
          )
        )
          break;
      }
  }
};
