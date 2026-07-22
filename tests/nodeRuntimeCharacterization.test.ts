import { createHash } from "node:crypto";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import {
  executeNodeCharacterization,
  prepareNodeCharacterization,
} from "../src/application/NodeRuntimeCharacterizationService.js";
import type {
  JavaScriptReplayHost,
  JavaScriptReplayPolicy,
  JavaScriptReplayRunner,
} from "../src/application/JavaScriptReplayPlanning.js";
import { PermissionAuthority } from "../src/application/PermissionAuthority.js";
import { createPermissionPolicy } from "../src/domain/permissionPolicy.js";
import {
  nodeCharacterizationPreparationInputSchema,
  nodeCharacterizationPreparationOutputSchema,
} from "../src/domain/nodeRuntimeCharacterization.js";

const roots: string[] = [];
const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Node runtime characterization", () => {
  it("prepares without execution, then executes only the approved exact plan", async () => {
    const fixture = await createFixture();
    let executions = 0;
    const dependencies = dependenciesFor(fixture.root, () => {
      executions += 1;
    });
    const input = preparationInput(fixture);

    const prepared = await prepareNodeCharacterization(dependencies, input);
    expect(prepared.ok).toBe(true);
    expect(executions).toBe(0);
    if (!prepared.ok) throw prepared.error;
    const output = nodeCharacterizationPreparationOutputSchema.parse(
      prepared.value,
    );
    expect(output).toMatchObject({
      phase: "preparation",
      plan: {
        preparation_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        runtime: { family: "ecmascript", provider_id: "node-javascript" },
        authority: {
          preparation_approved: true,
          execution_approved: false,
        },
      },
      transformation: {
        original_sha256: fixture.sha256,
        output_format: "commonjs-factory",
      },
      transformation_evidence: {
        predicate_type: "rea.javascript-export-transformation/v1",
        authority: "shipped-artifact",
      },
      replay: { phase: "plan" },
    });

    const stale = await executeNodeCharacterization(dependencies, {
      execution_approved: true,
      approved_plan_sha256: "0".repeat(64),
      preparation: input,
    });
    expect(stale.ok).toBe(false);
    expect(!stale.ok && stale.error._tag).toBe("ReplayPlanStaleError");
    expect(executions).toBe(0);

    const executed = await executeNodeCharacterization(dependencies, {
      execution_approved: true,
      approved_plan_sha256: output.plan.plan_sha256,
      preparation: input,
    });
    expect(executed.ok && executed.value).toMatchObject({
      phase: "execution",
      replay: {
        phase: "execute",
        evidence: { authority: "controlled-replay" },
      },
      evidence: {
        predicate_type: "rea.runtime-characterization/v1",
        authority: "controlled-replay",
      },
    });
    expect(executions).toBe(1);
    expect(await readFile(fixture.path)).toEqual(Buffer.from(fixture.bytes));
  });

  it("rejects aliases that cannot fit the provider-neutral plan identity", async () => {
    const input = preparationInput(await createFixture());
    expect(() =>
      nodeCharacterizationPreparationInputSchema.parse({
        ...input,
        selected_alias: "a".repeat(201),
      }),
    ).toThrow();
  });

  it("maps replay-only alias syntax to a provider-neutral module identity", async () => {
    const fixture = await createFixture();
    const input = preparationInput(fixture);
    const alias = "@scope/pkg";
    const prepared = await prepareNodeCharacterization(
      dependenciesFor(fixture.root, () => undefined),
      {
        ...input,
        selected_alias: alias,
        replay: {
          ...input.replay,
          left: {
            ...input.replay.left,
            entry_alias: alias,
            modules: input.replay.left.modules.map((module) => ({
              ...module,
              alias,
            })),
          },
        },
      },
    );

    expect(prepared.ok && prepared.value).toMatchObject({
      plan: {
        callable: {
          module_id: expect.stringMatching(/^module\/[a-f0-9]{64}$/u),
        },
      },
    });
  });
});

const createFixture = async () => {
  const root = await createTestTempDirectory("rea-characterization-");
  roots.push(root);
  const path = join(root, "bundle.js");
  const source = "const hidden = (value) => value.trim();";
  const selected = "(value) => value.trim()";
  const bytes = new TextEncoder().encode(source);
  await writeFile(path, bytes);
  const byteStart = source.indexOf(selected);
  return {
    root,
    path,
    bytes,
    sha256: sha256(bytes),
    byteStart,
    selectedBytes: new TextEncoder().encode(selected),
  };
};

const preparationInput = (
  fixture: Awaited<ReturnType<typeof createFixture>>,
) => ({
  preparation_approved: true,
  selected_alias: "bundle",
  expected_effect: "pure" as const,
  instrumentation: {
    artifact_path: fixture.path,
    artifact_sha256: fixture.sha256,
    selection: {
      byte_start: fixture.byteStart,
      byte_end: fixture.byteStart + fixture.selectedBytes.byteLength,
      selected_sha256: sha256(fixture.selectedBytes),
      export_name: "selected",
    },
  },
  replay: {
    mode: "plan" as const,
    left: {
      modules: [
        {
          alias: "bundle",
          path: fixture.path,
          format: "commonjs-factory" as const,
          role: "module" as const,
          dependencies: {},
        },
      ],
      entry_alias: "bundle",
      entry_export: "selected",
    },
    cases: [{ case_id: "trim", arguments: [" value "] }],
    approved: false,
  },
});

const dependenciesFor = (root: string, onExecute: () => void) => {
  const policy: JavaScriptReplayPolicy = {
    enabled: true,
    roots: [root],
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
      if (bytes.byteLength > maximumBytes)
        throw new RangeError("fixture limit");
      return { canonicalPath, bytes };
    },
    identifyExecutable: async (path) => ({
      path,
      version: "fixture-node-24",
      sha256: "1".repeat(64),
    }),
    identifyWorker: async () => ({
      path: "/fixture/worker.js",
      version: "fixture-worker",
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
  const runner: JavaScriptReplayRunner = {
    execute: async (prepared) => {
      onExecute();
      return {
        schema_version: 1,
        plan_digest: prepared.publicPlan.plan_digest,
        outcomes: [
          {
            case_id: "trim",
            outcome: "return",
            value: "value",
            input_sha256:
              prepared.publicPlan.cases[0]?.sha256 ?? "0".repeat(64),
            output_sha256: "4".repeat(64),
            truncated: false,
          },
        ],
        stderr: "",
        termination: "completed",
        cleanup: { state: "complete", residual_resources: [] },
        limitations: ["fixture runner"],
        reproducer: null,
      };
    },
  };
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
  return { policy, host, runner, authority };
};
