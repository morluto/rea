import { expect, it, vi } from "vitest";

const processList = vi.hoisted(() => vi.fn());
vi.mock("./ExecFileOutput.js", async (original) => ({
  ...(await original<typeof import("./ExecFileOutput.js")>()),
  execFileOutput: processList,
}));

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
    processList.mockReset().mockRejectedValue(native);
    const host = createSystemProcessOwnershipHost("linux", {});
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
    expect(processList).toHaveBeenCalledTimes(1);
    expect(processList.mock.calls[0]?.[0]).toBe("ps");
    expect(processList.mock.calls[0]?.[2]?.signal).toBe(controller.signal);
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
    processList.mockReset().mockRejectedValue(physical);
    const host = createSystemProcessOwnershipHost("linux", {});
    const pending =
      route === "list"
        ? host.listProcesses(controller.signal)
        : readRunTokenCarriers(host, "authored-run", controller.signal);
    await expect(pending).rejects.toBe(physical);
  },
);
