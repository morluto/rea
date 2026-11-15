import type { z } from "incur";

import type { BrowserObservationPort } from "../application/BrowserObservationPort.js";
import { createBrowserObservationProvider } from "../composition/browserObservation.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { Result } from "../domain/result.js";
import { browserCliError } from "./browserCliError.js";
import type { ContractCommandContext } from "./contractCommand.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";

/**
 * The CLI spelling shared by browser commands that select one CDP page
 * target: `<endpoint> <targetId>`, then the contract's scope and deadline
 * options.
 */
export const browserTargetProjection = {
  positionals: ["cdp_endpoint", "target_id"],
  fields: {
    cdp_endpoint: { name: "endpoint" },
    target_id: { description: "Target ID from list-browser-targets" },
    allowed_origins: { description: "Optional exact-origin filter" },
  },
} as const;

/**
 * Admit the contract input, then run one browser observation with a
 * disposable provider whose close the command awaits.
 */
export const observeThroughBrowser =
  <Schema extends z.ZodType>(
    contract: { readonly name: string; readonly inputSchema: Schema },
    run: (
      provider: BrowserObservationPort,
      input: z.output<Schema>,
      options: { readonly signal: AbortSignal },
    ) => Promise<Result<Evidence, AnalysisError>>,
  ) =>
  async (input: unknown, { signal }: ContractCommandContext) => {
    const parsed = contract.inputSchema.safeParse(input);
    if (!parsed.success)
      return browserCliError(
        analysisInputErrorFromIssues(contract.name, parsed.error.issues, input),
      );
    const provider = createBrowserObservationProvider();
    return finishAnalysisCommand(
      () => run(provider, parsed.data, { signal }),
      {
        close: async () => {
          await provider.close?.();
        },
      },
      provider.identity().id,
      contract.name,
      signal,
    ).then(projectCliAnalysisResult);
  };
