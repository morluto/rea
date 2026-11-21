import { toolContract } from "../../dist/contracts/toolContracts.js";
import { digestCanonicalValue } from "../../dist/domain/canonicalDigest.js";

const kinds = new Map([
  ["compare_process_captures", "behavioral"],
  ["compare_functions", "structural-function"],
  ["compare_artifacts", "structural-artifact"],
]);

/** Experimental public-MCP adapter. It does not run target code or score agents. */
export async function evaluatePack(pack, call) {
  if (
    pack?.format !== "rea-reconstruction-calibration/v1" ||
    !Array.isArray(pack.tasks) ||
    pack.tasks.length === 0
  )
    throw new Error(
      "Expected a nonempty rea-reconstruction-calibration/v1 task pack",
    );
  const ids = new Set();
  for (const task of pack.tasks) {
    if (typeof task.id !== "string" || !task.id.trim() || ids.has(task.id))
      throw new Error("Task IDs must be nonempty and unique");
    ids.add(task.id);
    if (!kinds.has(task.comparison?.operation))
      throw new Error(`Unsupported comparison operation for ${task.id}`);
    if (!Array.isArray(task.claims) || task.claims.length === 0)
      throw new Error(`Claims are required for ${task.id}`);
    toolContract(task.comparison.operation).inputSchema.parse(
      task.comparison.arguments,
    );
    toolContract("verify_reconstruction").inputSchema.parse({
      specification: {
        name: task.id,
        claims: task.claims.map((claim) => ({
          ...claim,
          kind: kinds.get(task.comparison.operation),
          comparison_evidence_id: `ev_${"0".repeat(64)}`,
        })),
      },
    });
  }
  const tasks = [];
  for (const task of pack.tasks) {
    let stage = task.comparison.operation;
    let compared;
    let input;
    try {
      compared = await checkedCall(call, stage, task.comparison.arguments);
      stage = "verify_reconstruction";
      input = {
        specification: {
          name: task.id,
          claims: task.claims.map((claim) => ({
            ...claim,
            kind: kinds.get(task.comparison.operation),
            comparison_evidence_id: compared.evidence_id,
          })),
        },
      };
      toolContract(stage).inputSchema.parse(input);
      const verified = await checkedCall(call, stage, input);
      tasks.push({
        id: task.id,
        execution: "completed",
        comparison_input: task.comparison,
        task_input: task,
        verification_input: input,
        comparison: compared,
        verification: verified,
      });
    } catch (error) {
      tasks.push({
        id: task.id,
        execution: "error",
        stage,
        comparison_input: task.comparison,
        task_input: task,
        verification_input: input,
        ...(compared ? { comparison: compared } : {}),
        error: error instanceof Error ? error.message : String(error),
        ...(error?.recovery ? { recovery: error.recovery } : {}),
      });
      // Stop: a failed tool may have left session state uncertain. Preserve prior results.
      break;
    }
  }
  return {
    format: "rea-reconstruction-calibration-result/v1",
    input_kind: "synthetic-calibration",
    task_pack_sha256: digestCanonicalValue(pack, "Calibration task pack"),
    task_count: pack.tasks.length,
    completed: tasks.filter((task) => task.execution === "completed").length,
    not_run: pack.tasks.slice(tasks.length).map((task) => task.id),
    tasks,
    limitations: [
      "Synthetic protocol calibration, not an agent benchmark or real-target evaluation.",
      "Pass means declared claims passed REA verification, not global implementation equivalence.",
      "Unknown is preserved as unknown. Tool errors and unrun tasks are not failed claims.",
      "No AgentRE-Bench or SRE-Bench format compatibility has been established.",
    ],
  };
}

async function checkedCall(call, name, arguments_) {
  const response = await call(name, arguments_);
  if (response?.isError) {
    const error = new Error(
      `${name} returned a tool error: ${JSON.stringify(response)}`,
    );
    const payloads = [response.structuredContent];
    for (const item of response.content ?? []) {
      if (item.type !== "text") continue;
      try {
        payloads.push(JSON.parse(item.text));
      } catch {
        /* Non-JSON errors remain in the original response. */
      }
    }
    const reference = payloads
      .filter(
        (item) =>
          item?.error?.code === "resource_constraint" &&
          item?.error?.details?.reported_limits?.boundary === "mcp-response",
      )
      .map((item) => item.error.details.reported_limits.evidence_reference)
      .find(
        (item) =>
          item?.kind === "retained-evidence" &&
          /^ev_[a-f0-9]{64}$/.test(item.evidence_id),
      );
    if (reference) {
      error.recovery = { reference, state: "unavailable" };
      try {
        const input = {
          detail: "records",
          filters: { evidence_id: reference.evidence_id },
          offset: 0,
          limit: 1,
        };
        toolContract("get_evidence_bundle").inputSchema.parse(input);
        // One bounded read only: never retry the completed comparison or recurse on overflow.
        const recovered = await call("get_evidence_bundle", input);
        if (recovered?.isError)
          throw new Error(
            `Retained Evidence read failed: ${JSON.stringify(recovered)}`,
          );
        const result = toolContract("get_evidence_bundle").outputSchema.parse(
          recovered?.structuredContent,
        ).result;
        const record =
          result.kind === "evidence-record-selection" &&
          result.records.length === 1
            ? result.records[0]
            : undefined;
        if (
          !record ||
          record.evidence_id !== reference.evidence_id ||
          record.operation !== name
        )
          throw new Error(
            "Referenced Evidence was not returned by the session.",
          );
        error.recovery = {
          reference,
          state: "recovered",
          evidence: toolContract(name).outputSchema.parse(record),
        };
      } catch (recoveryError) {
        error.recovery.error =
          recoveryError instanceof Error
            ? recoveryError.message
            : String(recoveryError);
      }
    }
    throw error;
  }
  return toolContract(name).outputSchema.parse(response?.structuredContent);
}
