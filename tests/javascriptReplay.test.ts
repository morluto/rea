import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runControlledReplay } from "../src/application/JavaScriptReplayService.js";
import type {
  JavaScriptReplayHost,
  JavaScriptReplayPolicy,
  JavaScriptReplayRunner,
} from "../src/application/JavaScriptReplayPlanning.js";
import { PermissionAuthority } from "../src/application/PermissionAuthority.js";
import { createPermissionPolicy } from "../src/domain/permissionPolicy.js";
import {
  controlledReplayInputSchema,
  controlledReplayOutputSchema,
} from "../src/domain/javascriptReplay.js";

const root = resolve("tests/fixtures/replay");
const policy: JavaScriptReplayPolicy = {
  enabled: true,
  roots: [root],
  nodePath: process.execPath,
  bubblewrapPath: "/usr/bin/bwrap",
  systemdRunPath: "/usr/bin/systemd-run",
  systemctlPath: "/usr/bin/systemctl",
  shellPath: "/usr/bin/bash",
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

const authority = (exportRoot?: string): PermissionAuthority => {
  const ceiling = {
    capability: "javascript_replay" as const,
    roots: [root],
    executables: [
      policy.nodePath,
      policy.bubblewrapPath,
      policy.systemdRunPath,
      policy.systemctlPath,
      policy.shellPath,
    ],
    environment_names: [],
    network: "none" as const,
    mount: true,
  };
  const exportCeiling =
    exportRoot === undefined
      ? []
      : [
          {
            capability: "evidence_write" as const,
            roots: [exportRoot],
            executables: [],
            environment_names: [],
            network: "none" as const,
            mount: false,
          },
        ];
  return new PermissionAuthority(
    createPermissionPolicy(
      [ceiling, ...exportCeiling],
      [
        {
          ...ceiling,
          grant_id: "administrator:javascript_replay",
          lifetime: "administrator",
          operation_identity: null,
          expires_at: null,
        },
        ...exportCeiling.map((item) => ({
          ...item,
          grant_id: "administrator:evidence_write",
          lifetime: "administrator" as const,
          operation_identity: null,
          expires_at: null,
        })),
      ],
    ),
  );
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
  approved: mode === "execute",
});

const completedRunner = (): JavaScriptReplayRunner => ({
  execute: async (prepared) => ({
    schema_version: 1,
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

describe("controlled JavaScript replay", () => {
  it("rejects relative paths and more than 128 combined cases", () => {
    expect(
      controlledReplayInputSchema.safeParse({
        ...input("plan", "relative/parser.mjs"),
      }).success,
    ).toBe(false);
    expect(
      controlledReplayInputSchema.safeParse({
        ...input("plan"),
        cases: Array.from({ length: 65 }, (_, index) => ({
          case_id: `explicit-${String(index)}`,
          arguments: [],
        })),
        generator: {
          preset: "parser-boundaries",
          seed: 1,
          count: 64,
        },
      }).success,
    ).toBe(false);
  });

  it("rejects oversized aggregate cases before probing or reading", async () => {
    const probe = vi.fn(host.probe);
    const readSource = vi.fn(host.readSource);
    const result = await runControlledReplay(
      {
        policy,
        host: { ...host, probe, readSource },
        runner: completedRunner(),
        authority: authority(),
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
      { policy, host, runner: { execute }, authority: authority() },
      input("plan"),
    );
    const second = await runControlledReplay(
      { policy, host, runner: { execute }, authority: authority() },
      input("plan"),
    );
    expect(first).toEqual(second);
    expect(execute).not.toHaveBeenCalled();
    expect(first.ok && first.value).toMatchObject({
      phase: "plan",
      plan: { network: "none", filesystem: { host_writes: false } },
      evidence: null,
    });
  });

  it("rejects a stale digest before worker admission", async () => {
    const execute = vi.fn(completedRunner().execute);
    const result = await runControlledReplay(
      { policy, host, runner: { execute }, authority: authority() },
      { ...input("execute"), plan_digest: "0".repeat(64) },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error._tag).toBe("ReplayPlanStaleError");
    expect(execute).not.toHaveBeenCalled();
  });

  it("creates controlled-replay Evidence after an approved exact plan", async () => {
    const dependencies = {
      policy,
      host,
      runner: completedRunner(),
      authority: authority(),
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
  });

  it("cannot read or execute when replay is disabled", async () => {
    const readSource = vi.fn(host.readSource);
    const execute = vi.fn(completedRunner().execute);
    const result = await runControlledReplay(
      {
        policy: { ...policy, enabled: false },
        host: { ...host, readSource },
        runner: { execute },
        authority: authority(),
      },
      input("plan"),
    );
    expect(result.ok).toBe(false);
    expect(readSource).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("changes the commitment when selected module bytes change", async () => {
    const dependencies = {
      policy,
      host,
      runner: completedRunner(),
      authority: authority(),
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

  it("projects an observed cancelled termination through the shared error algebra", async () => {
    const execute = vi.fn<JavaScriptReplayRunner["execute"]>(
      async (prepared) => ({
        schema_version: 1,
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
      policy,
      host,
      runner: { execute },
      authority: authority(),
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
      policy,
      controller.signal,
    );
  });

  it("does not admit a worker after cancellation during planning", async () => {
    const controller = new AbortController();
    const execute = vi.fn(completedRunner().execute);
    const result = await runControlledReplay(
      {
        policy,
        host: {
          ...host,
          probe: async () => {
            controller.abort();
          },
        },
        runner: { execute },
        authority: authority(),
      },
      { ...input("execute"), plan_digest: "0".repeat(64) },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error._tag).toBe("AnalysisCancelledError");
    expect(execute).not.toHaveBeenCalled();
  });

  it("exports an owner-only source-free reproducer after cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-reproducer-test-"));
    const path = join(directory, "reproducer.json");
    const dependencies = {
      policy,
      host,
      runner: completedRunner(),
      authority: authority(directory),
    };
    const export_ = {
      path,
      approved: true,
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
        schema_version: 1,
        sources: null,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
