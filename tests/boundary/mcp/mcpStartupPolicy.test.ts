import { describe, expect, it, vi } from "vitest";

import { readFile, watch } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";

import { settledCause } from "../../support/lifecycleHarness.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { testWaitDeadline } from "../../support/testWait.js";
import { MAX_NODE_TIMER_DELAY_MS } from "../../../src/domain/analysisResourceLimits.js";

import {
  createEsmModuleProfileCollector,
  measureMcpStartup,
  parseLinuxVmRssBytes,
  profileMcpModuleLoading,
} from "../../../scripts/lib/mcp-startup-probe.mjs";
import {
  resolveMcpStartupBudgets,
  type McpPhaseBudget,
} from "../../../src/config/mcpStartupBudgets.js";
import { mcpDoctorDeadlineRecovery } from "../../../src/config/mcpStartupPolicy.js";

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const expectPhaseText = (text: string, budget: McpPhaseBudget) => {
  expect(text).toContain(budget.setting);
  expect(text).toContain(budget.phase);
  expect(text).toContain(`${String(budget.milliseconds)} ms`);
  expect(text).toContain(`source ${budget.source}`);
  expect(text).toContain(`default ${String(budget.defaultMilliseconds)} ms`);
  expect(text).toContain(`floor ${String(budget.floorMilliseconds)} ms`);
  expect(text).toContain(`maximum ${String(budget.maximumMilliseconds)} ms`);
  expect(text).toContain("then restart REA");
};

const expectThrownBudget = async (
  pending: Promise<unknown>,
  budget: McpPhaseBudget,
): Promise<string> => {
  const failure = await settledCause(pending);
  expect(failure).toBeInstanceOf(Error);
  const message = errorMessage(failure);
  expectPhaseText(message, budget);
  return message;
};

describe("MCP startup policy", () => {
  it("distinguishes the doctor budget from Codex client guidance", () => {
    const budget = resolveMcpStartupBudgets({}).doctor;
    const doctor = mcpDoctorDeadlineRecovery(budget);
    expectPhaseText(doctor, budget);
    expect(doctor).toContain(
      "Codex startup_timeout_sec of 30 seconds is client guidance",
    );
    expect(doctor).toContain(
      "REA does not enforce that figure as this deadline",
    );
  });

  it("parses Linux resident memory without accepting other fields", () => {
    expect(
      parseLinuxVmRssBytes("Name:\tnode\nVmRSS:\t  12345 kB\nThreads:\t7\n"),
    ).toBe(12_641_280);
    expect(parseLinuxVmRssBytes("VmSize:\t12345 kB\n")).toBeNull();
  });

  it("profiles unique file-backed ESM modules without retaining paths", () => {
    const collector = createEsmModuleProfileCollector();
    collector.append(
      "ESM 1: Storing file:///opt/node_modules/rea-agents/dist/main.js\n" +
        "ESM 1: Translating StandardModule file:///opt/node_modules/rea-agents/dist/main.js\n" +
        "ESM 1: Storing file:///opt/rea/node_modules/zod/index.js",
    );

    expect(collector.result()).toEqual({
      supported: true,
      method: "node-debug-esm",
      unique_file_modules: 2,
      unique_package_modules: 1,
      unique_dependency_modules: 1,
      debug_lines: 3,
      truncated: false,
    });
  });
});

const probeChild = resolve("tests/fixtures/mcpStartupProbeChild.mjs");

const probePolicy = (
  overrides: Partial<{
    initializeBudgetMs: number;
    toolsListBudgetMs: number;
    firstCatalogBudgetMs: number;
    doctorDeadlineMs: number;
  }> = {},
) => {
  const generous = 30_000;
  return resolveMcpStartupBudgets({
    REA_MCP_INITIALIZE_BUDGET_MS: String(
      overrides.initializeBudgetMs ?? generous,
    ),
    REA_MCP_TOOLS_LIST_BUDGET_MS: String(
      overrides.toolsListBudgetMs ?? generous,
    ),
    REA_MCP_FIRST_CATALOG_BUDGET_MS: String(
      overrides.firstCatalogBudgetMs ?? generous,
    ),
    REA_MCP_DOCTOR_DEADLINE_MS: String(overrides.doctorDeadlineMs ?? generous),
  });
};

describe("packaged MCP startup probe failures", () => {
  it("names the initialize budget when that phase times out", async () => {
    const budgetMs = 200;
    const policy = probePolicy({ initializeBudgetMs: budgetMs });
    await expectThrownBudget(
      measureMcpStartup({
        command: process.execPath,
        args: [probeChild],
        environment: { ...process.env, REA_MCP_PROBE_MODE: "hang" },
        policy,
      }),
      policy.initialize,
    );
  });

  it("names the tools/list budget when that phase times out", async () => {
    const budgetMs = 200;
    const policy = probePolicy({ toolsListBudgetMs: budgetMs });
    await expectThrownBudget(
      measureMcpStartup({
        command: process.execPath,
        args: [probeChild],
        environment: {
          ...process.env,
          REA_MCP_PROBE_MODE: "initialize-then-hang",
        },
        policy,
      }),
      policy.toolsList,
    );
  });

  it("does not add timeout guidance to an unrelated startup failure", async () => {
    try {
      await measureMcpStartup({
        command: process.execPath,
        args: [probeChild],
        environment: { ...process.env, REA_MCP_PROBE_MODE: "fail" },
        policy: probePolicy(),
      });
      throw new Error("expected the unrelated probe failure");
    } catch (cause) {
      const message = errorMessage(cause);
      expect(message).toContain("unrelated probe failure");
      expect(message).not.toContain("expected the unrelated probe failure");
      for (const budget of Object.values(probePolicy()))
        expect(message).not.toContain(budget.setting);
    }
  });

  it("names the doctor deadline when module profiling cannot initialize", async () => {
    const budgetMs = 200;
    const policy = probePolicy({ doctorDeadlineMs: budgetMs });
    await expectThrownBudget(
      profileMcpModuleLoading({
        command: process.execPath,
        args: [probeChild],
        environment: { ...process.env, REA_MCP_PROBE_MODE: "hang" },
        policy,
        packageName: "rea-agents",
      }),
      policy.doctor,
    );
  });

  it("names the tools/list budget when module profiling passes initialize", async () => {
    const budgetMs = 200;
    const policy = probePolicy({ toolsListBudgetMs: budgetMs });
    await expectThrownBudget(
      profileMcpModuleLoading({
        command: process.execPath,
        args: [probeChild],
        environment: {
          ...process.env,
          REA_MCP_PROBE_MODE: "initialize-then-hang",
        },
        policy,
        packageName: "rea-agents",
      }),
      policy.toolsList,
    );
  });

  it("keeps a remote tools/list refusal separate from a module-profile deadline", async () => {
    const message = "upstream catalog cache timed out before this connection";
    const policy = probePolicy();
    await expect(
      profileMcpModuleLoading({
        command: process.execPath,
        args: [probeChild],
        environment: {
          ...process.env,
          REA_MCP_PROBE_MODE: "refuse-list",
          REA_MCP_PROBE_ERROR_MESSAGE: message,
        },
        policy,
        packageName: "rea-agents",
      }),
    ).rejects.toMatchObject({ code: -32601, message });
  });
});

// The pending phase's own budget is the largest Node can schedule, longer
// than any test deadline, so only the first-catalog budget can end the wait
// before the test's deadline does.
describe("packaged MCP first-catalog budget while a phase is pending", () => {
  it.each([
    [
      "initialize",
      "hang",
      { initializeBudgetMs: MAX_NODE_TIMER_DELAY_MS },
      "REA_MCP_INITIALIZE_BUDGET_MS",
    ],
    [
      "tools/list",
      "initialize-then-hang",
      { toolsListBudgetMs: MAX_NODE_TIMER_DELAY_MS },
      "REA_MCP_TOOLS_LIST_BUDGET_MS",
    ],
  ] as const)(
    "stops a pending %s at the first-catalog budget",
    async (method, mode, phaseOverride, phaseSetting) => {
      const root = await createTestTempDirectory("rea-mcp-startup-");
      const marker = "pending-request";
      const path = join(root, marker);
      const policy = probePolicy({
        ...phaseOverride,
        firstCatalogBudgetMs: 800,
      });
      const watcher = new AbortController();
      const pendingMethod = (async () => {
        for await (const event of watch(root, {
          signal: AbortSignal.any([
            watcher.signal,
            AbortSignal.timeout(testWaitDeadline()),
          ]),
        })) {
          if (event.filename !== marker) continue;
          const requested = await readFile(path, "utf8").catch(
            (cause: unknown) => {
              if (
                cause instanceof Error &&
                "code" in cause &&
                cause.code === "ENOENT"
              )
                return "";
              throw cause;
            },
          );
          if (requested.length > 0) return requested;
        }
        return undefined;
      })();
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const clock = vi
        .spyOn(performance, "now")
        .mockImplementation(() => Date.now());
      const operation = measureMcpStartup({
        command: process.execPath,
        args: [probeChild],
        environment: {
          ...process.env,
          REA_MCP_PROBE_MODE: mode,
          REA_MCP_PROBE_READY_PATH: path,
        },
        policy,
      });
      const settled = settledCause(operation);
      try {
        expect(await Promise.race([pendingMethod, settled])).toBe(method);
        await vi.advanceTimersByTimeAsync(policy.firstCatalog.milliseconds);
        const message = await expectThrownBudget(
          operation,
          policy.firstCatalog,
        );
        expect(message).not.toContain(phaseSetting);
      } finally {
        watcher.abort();
        await vi.advanceTimersByTimeAsync(policy.firstCatalog.milliseconds);
        await settled;
        clock.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("returns the catalog when every phase finishes inside its budget", async () => {
    const measurement = await measureMcpStartup({
      command: process.execPath,
      args: [probeChild],
      environment: { ...process.env, REA_MCP_PROBE_MODE: "serve" },
      policy: probePolicy(),
    });
    expect(measurement.listed_tool_count).toBe(0);
    expect(measurement.process_started_to_initialized_ms).toBeGreaterThan(0);
    expect(measurement.process_started_to_tools_list_ms).toBeGreaterThan(0);
    expect(measurement.process_started_to_tools_list_ms).toBeLessThan(30_000);
  });
});
