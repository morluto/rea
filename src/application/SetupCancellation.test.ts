import { expect, it } from "vitest";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { runSetup } from "./Setup.js";
import { FakeSetupHost, options } from "./Setup.fixture.js";

it.each(["initial", "approval", "client", "skill", "hopper", "close"] as const)(
  "stops later setup writes after cancellation during %s and awaits close",
  async (stage) => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled setup");
    const base = new FakeSetupHost("darwin");
    base.clients = ["cursor", "codex"].map((name) => ({
      name,
      configPath: `/fixture/${name}.json`,
      format: "json" as const,
    }));
    base.doctorHealthy = true;
    let closed = false;
    const initial = base.initialSetupState;
    const configure = base.configureClient;
    const host = Object.assign(base, {
      initialSetupState: async (...args: Parameters<typeof initial>) => {
        const state = await initial(...args);
        if (stage === "initial") controller.abort(reason);
        return state;
      },
      configureClient: async (...args: Parameters<typeof configure>) => {
        const result = await configure(...args);
        if (stage === "client") controller.abort(reason);
        return result;
      },
      close: async () => {
        await Promise.resolve();
        closed = true;
        if (stage === "close") controller.abort(reason);
        return undefined;
      },
    });
    const failure: unknown = await runSetup(
      {
        ...options(stage !== "approval"),
        signal: controller.signal,
        structured: false,
        clientIds: ["cursor", "codex"],
        proposeHopper: false,
        installHopper: stage === "hopper",
        onProgress: (event) => {
          if (
            ((stage === "skill" && event.actionId === "install_skill") ||
              (stage === "hopper" && event.actionId === "install_hopper")) &&
            event.state === "started"
          )
            controller.abort(reason);
        },
      },
      host,
      async () => {
        controller.abort(reason);
        return true;
      },
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AnalysisCancelledError);
    expect(failure).toMatchObject({ cause: reason });
    expect(closed).toBe(true);
    expect(base.configurations).toBe(
      stage === "client" ? 1 : stage === "skill" || stage === "close" ? 2 : 0,
    );
    expect(base.skillInstalls + base.hopperInstalls).toBe(
      stage === "close" ? 1 : 0,
    );
  },
);

it("closes the host without starting discovery when setup is already cancelled", async () => {
  const base = new FakeSetupHost(process.platform);
  let closed = false;
  const host = Object.assign(base, {
    close: async () => {
      closed = true;
      return undefined;
    },
  });
  const controller = new AbortController();
  controller.abort("cancel before setup");
  await expect(
    runSetup({ ...options(true), signal: controller.signal }, host),
  ).rejects.toBeInstanceOf(AnalysisCancelledError);
  expect(closed).toBe(true);
  expect(base.doctorCalls).toBe(0);
});
