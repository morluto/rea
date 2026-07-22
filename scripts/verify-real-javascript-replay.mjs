#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { PermissionAuthority } from "../dist/application/PermissionAuthority.js";
import { runControlledReplay } from "../dist/application/JavaScriptReplayService.js";
import { createPermissionPolicy } from "../dist/domain/permissionPolicy.js";
import { LinuxJavaScriptReplayRunner } from "../dist/replay/LinuxJavaScriptReplayRunner.js";
import { SystemJavaScriptReplayHost } from "../dist/replay/SystemJavaScriptReplayHost.js";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";

const verifierRun = createVerifierRun();

const suppliedInputPath = process.env.REA_REPLAY_INPUT_PATH;
const suppliedInput =
  suppliedInputPath === undefined
    ? undefined
    : JSON.parse(await readFile(await realpath(suppliedInputPath), "utf8"));
const canonicalSide = async (side) => ({
  ...side,
  modules: await Promise.all(
    side.modules.map(async (module) => ({
      ...module,
      path: await realpath(module.path),
    })),
  ),
});
const leftPath = await realpath(
  process.env.REA_REPLAY_LEFT_PATH ??
    resolve("tests/fixtures/replay/parser.mjs"),
);
const rightPath = await realpath(
  process.env.REA_REPLAY_RIGHT_PATH ??
    resolve("tests/fixtures/replay/parser-v2.mjs"),
);
const suppliedLeft =
  suppliedInput === undefined
    ? undefined
    : await canonicalSide(suppliedInput.left);
const suppliedRight =
  suppliedInput?.right === undefined
    ? undefined
    : await canonicalSide(suppliedInput.right);
const roots = [
  ...new Set(
    suppliedLeft === undefined
      ? [dirname(leftPath), dirname(rightPath)]
      : [...suppliedLeft.modules, ...(suppliedRight?.modules ?? [])].map(
          ({ path }) => dirname(path),
        ),
  ),
];
const policy = {
  enabled: true,
  roots,
  nodePath: process.execPath,
  bubblewrapPath:
    process.env.REA_JAVASCRIPT_REPLAY_BWRAP_PATH ?? "/usr/bin/bwrap",
  systemdRunPath:
    process.env.REA_JAVASCRIPT_REPLAY_SYSTEMD_RUN_PATH ??
    "/usr/bin/systemd-run",
  systemctlPath:
    process.env.REA_JAVASCRIPT_REPLAY_SYSTEMCTL_PATH ?? "/usr/bin/systemctl",
  shellPath: process.env.REA_JAVASCRIPT_REPLAY_SHELL_PATH ?? "/usr/bin/bash",
};
const ceiling = {
  capability: "javascript_replay",
  roots,
  executables: [
    policy.nodePath,
    policy.bubblewrapPath,
    policy.systemdRunPath,
    policy.systemctlPath,
    policy.shellPath,
  ],
  environment_names: [],
  network: "none",
  mount: true,
};
const authority = new PermissionAuthority(
  createPermissionPolicy(
    [ceiling],
    [
      {
        ...ceiling,
        grant_id: "administrator:javascript_replay",
        lifetime: "administrator",
        operation_identity: null,
        expires_at: null,
      },
    ],
  ),
);
const dependencies = {
  policy,
  host: new SystemJavaScriptReplayHost(),
  runner: new LinuxJavaScriptReplayRunner(),
  authority,
};
const defaultInput = {
  mode: "plan",
  left: {
    modules: [
      {
        alias: "parser",
        path: leftPath,
        format: "esm",
        role: "module",
        dependencies: {},
      },
    ],
    entry_alias: "parser",
    entry_export: "default",
  },
  right: {
    modules: [
      {
        alias: "parser",
        path: rightPath,
        format: "esm",
        role: "module",
        dependencies: {},
      },
    ],
    entry_alias: "parser",
    entry_export: "default",
  },
  cases: [
    { case_id: "heading", arguments: ["# Title"] },
    { case_id: "plain", arguments: ["plain"] },
  ],
  generator: { preset: "parser-boundaries", seed: 7, count: 4 },
  approved: false,
};
const input =
  suppliedInput === undefined
    ? defaultInput
    : {
        ...suppliedInput,
        mode: "plan",
        left: suppliedLeft,
        ...(suppliedRight === undefined ? {} : { right: suppliedRight }),
        approved: false,
        plan_digest: undefined,
        reproducer_export: undefined,
      };

const planned = await runControlledReplay(dependencies, input);
if (!planned.ok) {
  if (process.env.REA_REPLAY_ALLOW_UNAVAILABLE === "true") {
    process.stdout.write(
      `${JSON.stringify({ verifier_run: await completeVerifierRun(verifierRun), available: false, error_tag: planned.error._tag })}\n`,
    );
    process.exit(0);
  }
  throw planned.error;
}
const plan = planned.value.plan;
if (plan === null || typeof plan.plan_digest !== "string")
  throw new Error("Real replay verifier did not receive a plan");
const executed = await runControlledReplay(dependencies, {
  ...input,
  mode: "execute",
  approved: true,
  plan_digest: plan.plan_digest,
});
if (!executed.ok) throw executed.error;
const evidence = executed.value.evidence;
if (
  evidence === null ||
  evidence.authority !== "controlled-replay" ||
  evidence.environment?.isolation !== "container" ||
  evidence.normalized_result.termination !== "completed" ||
  evidence.normalized_result.cleanup.state !== "complete" ||
  evidence.normalized_result.comparison?.some(
    ({ status }) => status === "unknown",
  ) === true
)
  throw new Error("Real replay verifier received incomplete Evidence");

if (suppliedInput !== undefined) {
  process.stdout.write(
    `${JSON.stringify({
      verifier_run: await completeVerifierRun(verifierRun),
      available: true,
      supplied_manifest: true,
      plan_digest: plan.plan_digest,
      evidence_id: evidence.evidence_id,
      source_evidence_ids: executed.value.source_evidence.map(
        ({ evidence_id: id }) => id,
      ),
      left_sha256: plan.left.modules.map(({ sha256 }) => sha256),
      right_sha256: plan.right?.modules.map(({ sha256 }) => sha256) ?? [],
      cases: plan.cases.length,
      comparison:
        evidence.normalized_result.comparison?.map(({ case_id, status }) => ({
          case_id,
          status,
        })) ?? [],
      cleanup: evidence.normalized_result.cleanup.state,
    })}\n`,
  );
  process.exit(0);
}

const runSingle = async (path, limits = undefined) => {
  const manifest = {
    mode: "plan",
    left: {
      modules: [
        {
          alias: "entry",
          path: await realpath(path),
          format: "esm",
          role: "module",
          dependencies: {},
        },
      ],
      entry_alias: "entry",
      entry_export: "default",
    },
    cases: [{ case_id: "probe", arguments: [] }],
    ...(limits === undefined ? {} : { limits }),
    approved: false,
  };
  const proposed = await runControlledReplay(dependencies, manifest);
  if (!proposed.ok || proposed.value.plan === null)
    throw new Error("Replay conformance plan failed");
  const observed = await runControlledReplay(dependencies, {
    ...manifest,
    mode: "execute",
    approved: true,
    plan_digest: proposed.value.plan.plan_digest,
  });
  if (!observed.ok || observed.value.evidence === null)
    throw new Error("Replay conformance execution failed");
  return observed.value.evidence.normalized_result;
};

const sideEffects = await runSingle(
  resolve("tests/fixtures/replay/side-effect-attempt.mjs"),
);
if (
  sideEffects.outcomes[0]?.outcome !== "return" ||
  Object.values(sideEffects.outcomes[0].value).some(
    (value) => value !== "undefined",
  )
)
  throw new Error("Ambient side-effect surface was exposed to replay code");

const timeout = await runSingle(
  resolve("tests/fixtures/replay/busy-loop.mjs"),
  {
    wall_time_ms: 100,
  },
);
if (timeout.termination !== "timeout" || timeout.cleanup.state !== "complete")
  throw new Error("Replay timeout did not kill and clean the complete sandbox");

const differentialTimeoutInput = {
  mode: "plan",
  left: {
    modules: [
      {
        alias: "entry",
        path: await realpath(resolve("tests/fixtures/replay/busy-loop.mjs")),
        format: "esm",
        role: "module",
        dependencies: {},
      },
    ],
    entry_alias: "entry",
    entry_export: "default",
  },
  right: {
    modules: [
      {
        alias: "entry",
        path: await realpath(resolve("tests/fixtures/replay/parser.mjs")),
        format: "esm",
        role: "module",
        dependencies: {},
      },
    ],
    entry_alias: "entry",
    entry_export: "default",
  },
  cases: [{ case_id: "probe", arguments: [] }],
  limits: { wall_time_ms: 100 },
  approved: false,
};
const differentialTimeoutPlan = await runControlledReplay(
  dependencies,
  differentialTimeoutInput,
);
if (!differentialTimeoutPlan.ok || differentialTimeoutPlan.value.plan === null)
  throw new Error("Differential timeout plan failed");
const differentialTimeout = await runControlledReplay(dependencies, {
  ...differentialTimeoutInput,
  mode: "execute",
  approved: true,
  plan_digest: differentialTimeoutPlan.value.plan.plan_digest,
});
if (
  !differentialTimeout.ok ||
  differentialTimeout.value.evidence === null ||
  differentialTimeout.value.source_evidence.length !== 2 ||
  differentialTimeout.value.evidence.normalized_result.comparison?.[0]
    ?.status !== "unknown" ||
  differentialTimeout.value.source_evidence.some(
    (item) => item.normalized_result.outcomes[0]?.outcome !== "timeout",
  )
)
  throw new Error("Differential termination did not retain both observations");

const memory = await runSingle(
  resolve("tests/fixtures/replay/memory-pressure.mjs"),
  { wall_time_ms: 3000, memory_bytes: 32 * 1024 * 1024 },
);
if (memory.termination !== "oom" || memory.cleanup.state !== "complete")
  throw new Error(
    `Replay OOM did not report and clean the cgroup limit: ${JSON.stringify(memory)}`,
  );
process.stdout.write(
  `${JSON.stringify({
    verifier_run: await completeVerifierRun(verifierRun),
    available: true,
    plan_digest: plan.plan_digest,
    evidence_id: evidence.evidence_id,
    left_sha256: plan.left.modules[0]?.sha256,
    right_sha256: plan.right?.modules[0]?.sha256,
    cases: plan.cases.length,
    comparison: evidence.normalized_result.comparison?.map(
      ({ case_id, status }) => ({ case_id, status }),
    ),
    cleanup: evidence.normalized_result.cleanup.state,
    side_effect_surface: "unavailable",
    timeout: timeout.termination,
    differential_timeout:
      differentialTimeout.value.evidence.normalized_result.comparison[0]
        ?.status,
    memory: memory.termination,
  })}\n`,
);
