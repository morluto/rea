import { describe, expect, it, onTestFinished } from "vitest";
import { CdpWebRuntimeProvider } from "../../../src/browser/execution/CdpWebRuntimeProvider.js";
import type { CdpEvent } from "../../../src/browser/CdpConnection.js";
import { observeWebExecutionInputSchema } from "../../../src/domain/webExecution.js";
import { startRuntimeBrowser } from "../../fixtures/webRuntime.js";

describe("runtime flat-session lifecycle", () => {
  it("rejects a producer detachment between counter startup and local arming", async () => {
    let emitEvent: ((event: CdpEvent) => void) | undefined;
    const browser = await startRuntimeBrowser({
      commandResult: (command) => {
        if (command.method !== "Profiler.startPreciseCoverage")
          return undefined;
        emitEvent?.({
          method: "Target.detachedFromTarget",
          params: { sessionId: "session-1" },
        });
        return { timestamp: 12 };
      },
    });
    emitEvent = browser.emitEvent;
    onTestFinished(() => browser.close());
    let reportedArmed = false;
    const result = await new CdpWebRuntimeProvider().observeExecution(
      observeWebExecutionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "allowed-page",
        observation_ms: 2_147_483_647,
      }),
      {
        signal: AbortSignal.timeout(2_000),
        progress: {
          report: async (update) => {
            if (update.completed === 1) reportedArmed = true;
          },
        },
      },
    );
    if (result.ok)
      throw new Error("A terminated target cannot arm an execution window");
    expect(result.error).toMatchObject({ reason: "target_changed" });
    expect(reportedArmed).toBe(false);
  });

  it("ends immediately on its root detachment without confusing another session", async () => {
    const browser = await startRuntimeBrowser();
    onTestFinished(() => browser.close());
    const result = await new CdpWebRuntimeProvider().observeExecution(
      observeWebExecutionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "allowed-page",
        observation_ms: 2_147_483_647,
      }),
      {
        signal: AbortSignal.timeout(2_000),
        progress: {
          report: async (update) => {
            if (update.completed !== 1) return;
            browser.emitEvent({
              method: "Target.detachedFromTarget",
              params: { sessionId: "another-session" },
            });
            browser.emitEvent({
              method: "Target.detachedFromTarget",
              params: { sessionId: "session-1" },
            });
          },
        },
      },
    );
    if (!result.ok) throw result.error;
    expect(result.value.window.end_reason).toBe("target_terminated");
    expect(result.value.coverage.state).toBe("unavailable");
    expect(result.value.instrumentation.takes_one_resetting_sample).toBe(false);
  });

  it("ignores root detachment for a different flat session", async () => {
    const browser = await startRuntimeBrowser();
    onTestFinished(() => browser.close());
    const result = await new CdpWebRuntimeProvider().observeExecution(
      observeWebExecutionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "allowed-page",
        observation_ms: 30,
      }),
      {
        progress: {
          report: async (update) => {
            if (update.completed === 1)
              browser.emitEvent({
                method: "Target.detachedFromTarget",
                params: { sessionId: "another-session" },
              });
          },
        },
      },
    );
    if (!result.ok) throw result.error;
    expect(result.value.window.end_reason).toBe("window_elapsed");
  });
});

describe("coverage URL representation", () => {
  it("sanitizes proven resource URLs while preserving declared source names", async () => {
    let resourceUrl = "";
    let declaredUrl = "";
    const browser = await startRuntimeBrowser({
      commandResult: (command) => {
        if (command.method === "Profiler.takePreciseCoverage")
          return {
            timestamp: 12,
            result: [
              { scriptId: "transport-script", url: resourceUrl, functions: [] },
              { scriptId: "declared-script", url: declaredUrl, functions: [] },
            ],
          };
        if (
          command.method === "Debugger.getScriptSource" &&
          ["transport-script", "declared-script"].includes(
            String(command.params.scriptId),
          )
        )
          return { scriptSource: ";" };
        return undefined;
      },
    });
    onTestFinished(() => browser.close());
    resourceUrl =
      browser.endpoint.replace("http://", "http://transport:credential@") +
      "/resource.js?caller=value#fragment";
    declaredUrl =
      browser.endpoint.replace("http://", "http://declared:label@") +
      "/declared.js?caller=value#fragment";
    const result = await new CdpWebRuntimeProvider().observeExecution(
      observeWebExecutionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "allowed-page",
        observation_ms: 30,
      }),
      {
        progress: {
          report: async (update) => {
            if (update.completed !== 1) return;
            for (const [scriptId, url, hasSourceURL] of [
              ["transport-script", resourceUrl, false],
              ["declared-script", declaredUrl, true],
            ] as const)
              browser.emitEvent({
                method: "Debugger.scriptParsed",
                sessionId: "session-1",
                params: {
                  scriptId,
                  url,
                  hasSourceURL,
                  executionContextId: 1,
                  executionContextAuxData: { frameId: "runtime-main" },
                  startLine: 0,
                  startColumn: 0,
                  endLine: 0,
                  endColumn: 1,
                },
              });
          },
        },
      },
    );
    if (!result.ok) throw result.error;
    expect(
      result.value.coverage.scripts.map(({ reported_url }) => reported_url),
    ).toEqual([
      `${browser.endpoint}/resource.js?caller=value#fragment`,
      declaredUrl,
    ]);
    expect(JSON.stringify(result.value)).not.toContain("transport:credential@");
  });
});
