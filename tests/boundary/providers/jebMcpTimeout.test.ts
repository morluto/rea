import { withVerifierCleanup } from "../../../scripts/lib/verifier-cleanup.mjs";
import { expect, it, vi } from "vitest";
import { createJebAnalysisProvider } from "../../../src/composition/jeb.js";
import { AnalysisTimeoutError } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { testWaitDeadline } from "../../support/testWait.js";
import {
  startJebMcpFixture,
  jebPrimaryResponses,
} from "../../fixtures/jebMcp.js";

it.each([
  { operation: "inspect_jeb_client", stage: "catalog" },
  { operation: "inspect_jeb_client", stage: "tool" },
  { operation: "list_jeb_units", stage: "catalog" },
  { operation: "list_jeb_units", stage: "tool" },
] as const)(
  "attributes a real SDK $stage timeout to $operation",
  async ({ operation, stage }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const timeoutMs = 100;
    let reached = false;
    const holdReply = async () => {
      // Advance the request's clock only after it reaches the selected
      // protocol phase. The real HTTP handshake uses no fake elapsed time.
      reached = true;
      vi.advanceTimersByTime(timeoutMs);
      await gate;
    };
    const fixture = await startJebMcpFixture(
      async (tool) => {
        await holdReply();
        return jebPrimaryResponses[tool]!;
      },
      stage === "catalog"
        ? async () => {
            await holdReply();
            return { tools: [] };
          }
        : undefined,
    );
    const provider = createJebAnalysisProvider({
      REA_JEB_MCP_URL: fixture.endpoint,
      REA_JEB_MCP_TIMEOUT_MS: String(timeoutMs),
    });
    await withVerifierCleanup(async () => {
      const signal = AbortSignal.timeout(testWaitDeadline());
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "performance"],
      });
      const result = await provider.execute(
        operation === "inspect_jeb_client"
          ? { operation, input: {} }
          : { operation, input: { count: 2, index: 0 } },
        { signal },
      );
      expect(reached).toBe(true);
      if (result.ok) throw new Error("Timed-out MCP request passed");
      expect(result.error).toBeInstanceOf(AnalysisTimeoutError);
      expect(result.error).toMatchObject({ operation, timeoutMs });
      const projected = projectAnalysisError(result.error);
      expect(projected.message).toContain(
        stage === "catalog" ? "catalog discovery" : "tools/call",
      );
      expect(projected.message).toContain(`${timeoutMs} ms`);
      expect(projected.remediation.action).toContain("REA_JEB_MCP_TIMEOUT_MS");
      expect(projected.remediation.action).toContain("2147483647");
      expect(projected.remediation.action).toContain("60000");
      expect(projected.remediation.action).toContain(
        "update_analysis_settings",
      );
      expect(projected.details?.limit).toMatchObject({
        setting: "jeb.mcp_timeout_ms",
        effective_value: timeoutMs,
        source: "setting",
        update_mode: "runtime",
        pending_restart: false,
      });
      expect(result.error.cause).toBeDefined();
      expect(result.error.cleanupIncomplete).toBe(false);
    }, [
      () => {
        vi.useRealTimers();
        release();
      },
      async () => {
        await provider.close();
      },
      async () => {
        await fixture.close();
      },
    ]);
  },
);
