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
    try {
      compared = await checkedCall(call, stage, task.comparison.arguments);
      stage = "verify_reconstruction";
      const input = {
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
        comparison: compared,
        verification: verified,
      });
    } catch (error) {
      tasks.push({
        id: task.id,
        execution: "error",
        stage,
        comparison_input: task.comparison,
        ...(compared ? { comparison: compared } : {}),
        error: error instanceof Error ? error.message : String(error),
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
  if (response?.isError)
    throw new Error(
      `${name} returned a tool error: ${JSON.stringify(response)}`,
    );
  return toolContract(name).outputSchema.parse(response?.structuredContent);
}
