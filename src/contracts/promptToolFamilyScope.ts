import { PROMPT_CONTRACTS, type PromptContract } from "./promptContracts.js";
import { toolFamilyId } from "./toolFamilies.js";

/**
 * Require core workflow tools and omit optional routes whose tools are disabled.
 * Consumers share this projected contract so discovery, rendering and catalog
 * identity agree. An absent selection preserves the complete inventory.
 */
export const promptsForToolFamilies = (
  selection: ReadonlySet<string> | undefined,
  contracts: readonly PromptContract[] = PROMPT_CONTRACTS,
): readonly PromptContract[] =>
  selection === undefined
    ? contracts
    : contracts.flatMap((contract) => {
        const steps: PromptContract["steps"][number][] = [];
        for (const step of contract.steps) {
          const available = step.tools.every((tool) => {
            const family = toolFamilyId(tool);
            return family !== undefined && selection.has(family);
          });
          if (available) steps.push(step);
          else if (step.availability !== "optional") return [];
        }
        return [{ ...contract, steps }];
      });
