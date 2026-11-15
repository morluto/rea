import type { z } from "incur";

import type { BrowserObservationPort } from "../ports/BrowserObservationPort.js";
import { createBrowserObservationProvider } from "../composition/browserObservation.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import type { Result } from "../domain/result.js";
import { browserCliError } from "./browserCliError.js";
import {
  admittedContractInput,
  type ContractCommandContext,
} from "./contractCommand.js";
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
  async (_input: unknown, context: ContractCommandContext) => {
    const admitted = admittedContractInput(context);
    if (!admitted.ok) return browserCliError(admitted.error);
    const input = admitted.value as z.output<Schema>;
    const { signal } = context;
    const provider = createBrowserObservationProvider();
    return finishAnalysisCommand(
      () => run(provider, input, { signal }),
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
