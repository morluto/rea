import { expect, it } from "vitest";

import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import { ExecFileOutputCancelledError } from "./ExecFileOutput.js";
import { ProcessOwnershipInspectionCancelled } from "./ProcessInspectionCancellation.js";
import { createSystemProcessOwnershipHost } from "./ProcessOwnershipObservation.js";
import { readRunTokenCarriers } from "./ProcessRunTokenObservations.js";

const routes = ["list", "carriers"] as const;
const reasons = [
  null,
  { caller: "opaque" },
  new AnalysisOutputError("authored-read", "opaque error"),
] as const;

it.each(
  routes.flatMap((route) => reasons.map((reason) => ({ route, reason }))),
)(
  "retains explicit native command cancellation before $route parsing with opaque reason $reason",
  async ({ route, reason }) => {
    const controller = new AbortController();
    controller.abort(reason);
    const native = new ExecFileOutputCancelledError(reason);
    const reads: { command: string; signal: AbortSignal | undefined }[] = [];
    const host = createSystemProcessOwnershipHost(
      "linux",
      {},
      {
        execFileOutput: async (command, _arguments, options) => {
          reads.push({ command, signal: options?.signal });
          throw native;
        },
      },
    );
    const pending =
      route === "list"
        ? host.listProcesses(controller.signal)
        : readRunTokenCarriers(host, "authored-run", controller.signal);
    const failure = await pending.catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ProcessOwnershipInspectionCancelled);
    if (!(failure instanceof ProcessOwnershipInspectionCancelled))
      throw failure;
    expect(failure.reason).toBe(reason);
    expect(failure.cause).toBe(native);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.command).toBe("ps");
    expect(reads[0]?.signal).toBe(controller.signal);
  },
);

it.each(routes)(
  "preserves an independent physical AbortError-shaped rejection before %s parsing when reused as the abort reason",
  async (route) => {
    const controller = new AbortController();
    const physical = Object.assign(
      new Error("physical process table read failed"),
      {
        name: "AbortError",
        cause: { native: "independent fault" },
      },
    );
    controller.abort(physical);
    const host = createSystemProcessOwnershipHost(
      "linux",
      {},
      {
        execFileOutput: async () => {
          throw physical;
        },
      },
    );
    const pending =
      route === "list"
        ? host.listProcesses(controller.signal)
        : readRunTokenCarriers(host, "authored-run", controller.signal);
    await expect(pending).rejects.toBe(physical);
  },
);
