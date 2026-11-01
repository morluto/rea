import { expect, it } from "vitest";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { runSetup } from "./Setup.js";
import { FakeSetupHost, options } from "./Setup.fixture.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { setupOutcomeSnapshot } from "./SetupCancellation.js";
import { SetupSkillInstallError } from "./SetupSkill.js";

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
    if (stage === "client" || stage === "close") {
      if (!(failure instanceof AnalysisCancelledError))
        throw new Error("Expected cancellation");
      expect(failure.diagnostics?.setup_effects).toContainEqual({
        operation: "configure_client:cursor",
        result: { status: "configured" },
      });
      if (stage === "close")
        expect(failure.diagnostics?.setup_result).toMatchObject({
          appliedActions: [
            "configured_cursor",
            "configured_codex",
            "installed_skill",
          ],
        });
    }
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

it("retains rollback recovery facts when cancellation arrives as registration settles", async () => {
  const controller = new AbortController();
  const base = new FakeSetupHost(process.platform);
  base.clients = [
    { name: "cursor", configPath: "/fixture/cursor.json", format: "json" },
  ];
  const recovery = {
    status: "failed" as const,
    reason: "rollback" as const,
    backupPath: "/fixture/cursor.json.backup",
    failure: {
      kind: "restore" as const,
      path: "/fixture/cursor.json",
      detail: "permission denied restoring original",
    },
  };
  base.configureClient = async () => {
    controller.abort("cancel after rollback failure");
    return recovery;
  };
  const failure: unknown = await runSetup(
    {
      ...options(true),
      signal: controller.signal,
      clientIds: ["cursor"],
      proposeHopper: false,
    },
    base,
  ).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(AnalysisCancelledError);
  if (!(failure instanceof AnalysisCancelledError))
    throw new Error("Expected cancellation");
  expect(failure.diagnostics?.setup_effects).toEqual([
    { operation: "configure_client:cursor", result: recovery },
  ]);
  expect(JSON.stringify(projectAnalysisError(failure))).toContain(
    recovery.backupPath,
  );
  expect(base.skillInstalls).toBe(0);
});

it("snapshots skill recovery details without serializing cleanup capabilities", () => {
  const error = new SetupSkillInstallError({
    path: "/fixture/skill",
    stage: "write",
    reason: "write refused",
    rollbackFailures: [],
    recoveryBackupPaths: ["/fixture/skill.backup"],
    cause: new Error("permission denied"),
  });
  const snapshot = setupOutcomeSnapshot({ ok: false, error });
  expect(snapshot).toMatchObject({
    ok: false,
    error: {
      message: error.message,
      reason: error.reason,
      recoveryBackupPaths: error.recoveryBackupPaths,
      remediation: error.remediationAction,
    },
  });
  expect(JSON.stringify(snapshot)).not.toContain("cleanupOwners");
});
