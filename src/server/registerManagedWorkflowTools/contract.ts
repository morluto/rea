import { MANAGED_WORKFLOW_TOOL_CONTRACTS } from "../../contracts/managedWorkflowToolContracts.js";

/** Locate one managed workflow tool contract by exact name. */
export const managedWorkflowContract = (
  name: (typeof MANAGED_WORKFLOW_TOOL_CONTRACTS)[number]["name"],
) => {
  const found = MANAGED_WORKFLOW_TOOL_CONTRACTS.find(
    (candidate) => candidate.name === name,
  );
  if (found === undefined) throw new Error(`Missing ${name} contract`);
  return found;
};
