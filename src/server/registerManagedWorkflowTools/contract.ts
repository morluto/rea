import { MANAGED_WORKFLOW_TOOL_CONTRACTS } from "../../contracts/managedWorkflowToolContracts.js";

/** Locate one managed workflow tool contract by exact name. */
export function managedWorkflowContract(
  name: "compare_managed_members",
): (typeof MANAGED_WORKFLOW_TOOL_CONTRACTS)[0];
export function managedWorkflowContract(
  name: "verify_managed_native_boundaries",
): (typeof MANAGED_WORKFLOW_TOOL_CONTRACTS)[1];
export function managedWorkflowContract(
  name: "import_managed_reconstruction",
): (typeof MANAGED_WORKFLOW_TOOL_CONTRACTS)[2];
export function managedWorkflowContract(
  name: "plan_managed_runtime_correlation",
): (typeof MANAGED_WORKFLOW_TOOL_CONTRACTS)[3];
export function managedWorkflowContract(
  name: "project_managed_application_graph",
): (typeof MANAGED_WORKFLOW_TOOL_CONTRACTS)[4];
export function managedWorkflowContract(
  name: (typeof MANAGED_WORKFLOW_TOOL_CONTRACTS)[number]["name"],
) {
  const found = MANAGED_WORKFLOW_TOOL_CONTRACTS.find(
    (candidate) => candidate.name === name,
  );
  if (found === undefined) throw new Error(`Missing ${name} contract`);
  return found;
}
