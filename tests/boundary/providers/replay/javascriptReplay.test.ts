import { readFile, realpath, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { runControlledReplay } from "../../../../src/application/JavaScriptReplayService.js";
import type {
  JavaScriptReplayConfiguration,
  JavaScriptReplayHost,
  JavaScriptReplayRunner,
} from "../../../../src/application/JavaScriptReplayPlanning.js";
import {
  controlledReplayInputSchema,
  controlledReplayOutputSchema,
} from "../../../../src/domain/javascriptReplay.js";

const root = resolve("tests/fixtures/replay");
const configuration: JavaScriptReplayConfiguration = {
  nodePath: process.execPath,
  bubblewrapPath: process.execPath,
  systemdRunPath: process.execPath,
  systemctlPath: process.execPath,
  shellPath: process.execPath,
};

const host: JavaScriptReplayHost = {
  readSource: async (path, maximumBytes) => {
    const canonicalPath = await realpath(path);
    const bytes = await readFile(canonicalPath);
    if (bytes.byteLength > maximumBytes) throw new RangeError("fixture limit");
    return { canonicalPath, bytes };
  },
  identifyExecutable: async (path) => ({
    path,
    version: "fixture-1",
    sha256: "1".repeat(64),
  }),
  identifyWorker: async () => ({
    path: "/fixture/worker.js",
    version: "fixture-worker-1",
    sha256: "2".repeat(64),
  }),
  identifyRuntimeClosure: async (path) => [
    {
      sourcePath: path,
      destinationPath: "/runtime/node",
      sha256: "1".repeat(64),
    },
  ],
  seccompDigest: () => "3".repeat(64),
  probe: async () => undefined,
};

const input = (
  mode: "plan" | "execute",
  path = resolve(root, "parser.mjs"),
) => ({
  mode,
  left: {
    modules: [
      {
        alias: "parser",
        path,
        format: "esm" as const,
        role: "module" as const,
        dependencies: {},
      },
    ],
    entry_alias: "parser",
    entry_export: "default",
  },
  cases: [{ case_id: "heading", arguments: ["# Title"] }],
});
const completedRunner = (): JavaScriptReplayRunner => ({
  execute: async (prepared) => ({
    plan_digest: prepared.publicPlan.plan_digest,
    outcomes: [
      {
        case_id: "heading",
        outcome: "return",
        value: { type: "heading", text: "Title" },
        input_sha256: prepared.publicPlan.cases[0]?.sha256 ?? "0".repeat(64),
        output_sha256: "2".repeat(64),
        truncated: false,
      },
    ],
    stderr: "",
    termination: "completed",
    cleanup: { state: "complete", residual_resources: [] },
    limitations: ["fixture runner"],
    reproducer: null,
  }),
});

describe("controlled JavaScript replay planning", () => {
  it("requires an exact digest for execution and keeps plan input separate", () => {
    expect(
      controlledReplayInputSchema.safeParse({
        ...input("execute"),
        plan_digest: "0".repeat(64),
      }).success,
    ).toBe(true);
    expect(
      controlledReplayInputSchema.safeParse({
        ...input("execute"),
      }).success,
    ).toBe(false);
    expect(
      controlledReplayInputSchema.safeParse({
        ...input("plan"),
        plan_digest: "0".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      controlledReplayInputSchema.safeParse({
        ...input("plan"),
      }).success,
    ).toBe(true);
    expect(
      controlledReplayInputSchema.safeParse({
        ...input("execute"),
        plan_digest: "0".repeat(64),
        reproducer_export: {
          path: "/tmp/reproducer",
        },
      }).success,
    ).toBe(true);
  });

  it("rejects relative module paths", () => {
    expect(
      controlledReplayInputSchema.safeParse({
        ...input("plan", "relative/parser.mjs"),
      }).success,
    ).toBe(false);
  });

  it("accepts caller replay budgets above former tool-side ceilings", () => {
    expect(
      controlledReplayInputSchema.safeParse({
        ...input("plan"),
        generator: { preset: "parser-boundaries", seed: 1, count: 65 },
        limits: {
          wall_time_ms: 60_000,
          memory_bytes: 1024 * 1024 * 1024,
          tasks: 64,
          cpu_quota_percent: 200,
          tmpfs_bytes: 128 * 1024 * 1024,
          module_bytes: 32 * 1024 * 1024,
          input_bytes: 2 * 1024 * 1024,
          protocol_bytes: 128 * 1024 * 1024,
          output_bytes: 8 * 1024 * 1024,
          stderr_bytes: 512 * 1024,
          result_depth: 128,
          result_nodes: 200_000,
        },
      }).success,
    ).toBe(true);
  });

  it("rejects oversized aggregate cases before probing or reading", async () => {
    const probe = vi.fn(host.probe);
    const readSource = vi.fn(host.readSource);
    const result = await runControlledReplay(
      {
        configuration: () => configuration,
        host: { ...host, probe, readSource },
        runner: completedRunner(),
      },
      {
        ...input("plan"),
        cases: [{ case_id: "large", arguments: ["too large"] }],
        limits: { input_bytes: 1 },
      },
    );
    expect(result.ok).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    expect(readSource).not.toHaveBeenCalled();
  });

  it("returns a deterministic plan without admitting application code", async () => {
    const execute = vi.fn(completedRunner().execute);
    const first = await runControlledReplay(
      {
        configuration: () => configuration,
        host,
        runner: { execute },
      },
      input("plan"),
    );
    const second = await runControlledReplay(
      {
        configuration: () => configuration,
        host,
        runner: { execute },
      },
      input("plan"),
    );
    expect(first).toEqual(second);
    expect(execute).not.toHaveBeenCalled();
    expect(first.ok && first.value).toMatchObject({
      phase: "plan",
      plan: { network: "none", filesystem: { host_writes: false } },
      evidence: null,
    });
    if (!first.ok) throw first.error;
    const output = controlledReplayOutputSchema.parse(first.value);
    expect(
      controlledReplayOutputSchema.safeParse({ ...output, plan: null }).success,
    ).toBe(false);
    expect(
      controlledReplayOutputSchema.safeParse({ ...output, phase: "execute" })
        .success,
    ).toBe(false);
  });

  it("rejects a stale digest before worker admission", async () => {
    const execute = vi.fn(completedRunner().execute);
    const result = await runControlledReplay(
      {
        configuration: () => configuration,
        host,
        runner: { execute },
      },
      { ...input("execute"), plan_digest: "0".repeat(64) },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error._tag).toBe("ReplayPlanStaleError");
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("controlled JavaScript replay configuration snapshots", () => {
  it("uses one configuration snapshot for the complete planning operation", async () => {
    let reads = 0;
    const configuredReplay = (): JavaScriptReplayConfiguration => {
      reads += 1;
      return configuration;
    };
    const result = await runControlledReplay(
      {
        configuration: configuredReplay,
        host,
        runner: completedRunner(),
      },
      input("plan"),
    );
    expect([result.ok, reads]).toEqual([true, 1]);
  });
});

describe("controlled JavaScript replay evidence and plan identity", () => {
  it("plans and executes without grants after matching the content-bound plan", async () => {
    const dependencies = {
      configuration: () => configuration,
      host,
      runner: completedRunner(),
    };
    const planned = await runControlledReplay(dependencies, input("plan"));
    if (
      !planned.ok ||
      typeof planned.value !== "object" ||
      planned.value === null ||
      Array.isArray(planned.value)
    )
      throw new Error("missing fixture plan");
    const plan = planned.value.plan;
    if (
      typeof plan !== "object" ||
      plan === null ||
      Array.isArray(plan) ||
      typeof plan.plan_digest !== "string"
    )
      throw new Error("missing fixture digest");
    const executed = await runControlledReplay(dependencies, {
      ...input("execute"),
      plan_digest: plan.plan_digest,
    });
    expect(executed.ok && executed.value).toMatchObject({
      phase: "execute",
      plan: null,
      evidence: {
        provider: { id: "rea-javascript-replay" },
        authority: "controlled-replay",
        confidence: "observed",
        environment: { isolation: "container" },
      },
    });
    if (!executed.ok) throw executed.error;
    const output = controlledReplayOutputSchema.parse(executed.value);
    expect(output.source_evidence).toHaveLength(1);
    expect(output.source_evidence[0]?.confidence).toBe("observed");
    expect(output.evidence?.evidence_links).toEqual([
      output.source_evidence[0]?.evidence_id,
    ]);
    expect(
      controlledReplayOutputSchema.safeParse({
        ...output,
        source_evidence: [],
      }).success,
    ).toBe(false);
  });

  it("changes the commitment when selected module bytes change", async () => {
    const dependencies = {
      configuration: () => configuration,
      host,
      runner: completedRunner(),
    };
    const left = await runControlledReplay(dependencies, input("plan"));
    const right = await runControlledReplay(
      dependencies,
      input("plan", resolve(root, "parser-v2.mjs")),
    );
    expect(left.ok && right.ok && left.value).not.toEqual(
      right.ok && right.value,
    );
  });
});

describe("controlled JavaScript replay cancellation and export", () => {
  it("projects an observed cancelled termination through the shared error algebra", async () => {
    const execute = vi.fn<JavaScriptReplayRunner["execute"]>(
      async (prepared) => ({
        plan_digest: prepared.publicPlan.plan_digest,
        outcomes: [
          {
            case_id: "heading",
            outcome: "cancelled",
            input_sha256:
              prepared.publicPlan.cases[0]?.sha256 ?? "0".repeat(64),
            output_sha256: null,
            truncated: false,
          },
        ],
        stderr: "",
        termination: "cancelled",
        cleanup: { state: "complete", residual_resources: [] },
        limitations: ["fixture cancellation"],
        reproducer: null,
      }),
    );
    const dependencies = {
      configuration: () => configuration,
      host,
      runner: { execute },
    };
    const planned = await runControlledReplay(dependencies, input("plan"));
    if (!planned.ok) throw planned.error;
    const plan = controlledReplayOutputSchema.parse(planned.value).plan;
    if (plan === null) throw new Error("missing cancellation plan");
    const controller = new AbortController();
    const result = await runControlledReplay(
      dependencies,
      {
        ...input("execute"),
        plan_digest: plan.plan_digest,
      },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error._tag).toBe("AnalysisCancelledError");
    expect(execute).toHaveBeenCalledWith(
      expect.any(Object),
      configuration,
      controller.signal,
    );
  });

  it("does not admit a worker after cancellation during planning", async () => {
    const controller = new AbortController();
    const execute = vi.fn(completedRunner().execute);
    const result = await runControlledReplay(
      {
        configuration: () => configuration,
        host: {
          ...host,
          probe: async () => {
            controller.abort();
          },
        },
        runner: { execute },
      },
      { ...input("execute"), plan_digest: "0".repeat(64) },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error._tag).toBe("AnalysisCancelledError");
    expect(execute).not.toHaveBeenCalled();
  });

  it("exports an owner-only source-free reproducer after cleanup", async () => {
    const directory = await createTestTempDirectory("rea-reproducer-test-");
    const path = join(directory, "reproducer.json");
    const dependencies = {
      configuration: () => configuration,
      host,
      runner: completedRunner(),
    };
    const export_ = {
      path,
      include_sources: false,
    };
    try {
      const planned = await runControlledReplay(dependencies, {
        ...input("plan"),
        reproducer_export: export_,
      });
      if (!planned.ok) throw new Error("missing export plan");
      const plan = controlledReplayOutputSchema.parse(planned.value).plan;
      if (plan === null) throw new Error("missing export plan");
      const executed = await runControlledReplay(dependencies, {
        ...input("execute"),
        reproducer_export: export_,
        plan_digest: plan.plan_digest,
      });
      expect(executed.ok && executed.value).toMatchObject({
        evidence: {
          normalized_result: {
            reproducer: { state: "written", path },
          },
        },
      });
      const metadata = await stat(path);
      expect(metadata.mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        sources: null,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
