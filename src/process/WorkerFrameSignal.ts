import { OwnerCancellation } from "../domain/analysisErrorCore.js";
import type { ProviderProcessSupervisor } from "./ProviderProcess.js";

type FrameOutcome = "frame" | "failure";

/** Own frame waiters and release the losing output-close wait after each race. */
export class WorkerFrameSignal {
  readonly #waiters = new Set<(outcome: FrameOutcome) => void>();

  wake(outcome: FrameOutcome): void {
    for (const wake of this.#waiters) wake(outcome);
    this.clear();
  }

  clear(): void {
    this.#waiters.clear();
  }

  wait(signal: AbortSignal): Promise<FrameOutcome | "interrupted"> {
    if (signal.aborted) return Promise.resolve("interrupted");
    return new Promise((resolve) => {
      const settle = (outcome: FrameOutcome | "interrupted"): void => {
        this.#waiters.delete(settle);
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = () => settle("interrupted");
      this.#waiters.add(settle);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async waitForOutputClose(
    supervisor: ProviderProcessSupervisor,
    signal: AbortSignal,
  ): Promise<FrameOutcome | "closed" | "interrupted"> {
    const outputCloseController = new AbortController();
    const interruptOutputClose = () =>
      outputCloseController.abort(signal.reason);
    if (signal.aborted) interruptOutputClose();
    else signal.addEventListener("abort", interruptOutputClose, { once: true });
    try {
      const frameAvailable = this.wait(outputCloseController.signal);
      const outputClose = supervisor
        .waitForOutputClose(undefined, outputCloseController.signal)
        .then((closed): "closed" | "interrupted" =>
          closed ? "closed" : "interrupted",
        );
      return await Promise.race([frameAvailable, outputClose]);
    } finally {
      outputCloseController.abort(OwnerCancellation.noLongerNeeded);
      signal.removeEventListener("abort", interruptOutputClose);
    }
  }
}
