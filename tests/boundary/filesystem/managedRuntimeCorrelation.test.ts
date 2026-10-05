import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { planManagedRuntimeCorrelationEvidence } from "../../../src/application/ManagedRuntimeCorrelationService.js";
import { MANAGED_STATIC_PROVIDER } from "../../../src/application/InvestigationProviders.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import {
  managedRuntimeCorrelationInputSchema,
  managedRuntimeCorrelationResultSchema,
} from "../../../src/domain/managedRuntimeCorrelation.js";
import { inspectManagedMembersBytes } from "../../../src/dotnet/ManagedMemberInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "../../../src/dotnet/ManagedPe.fixture.js";

describe("managed runtime correlation planning", () => {
  it("records an exact-build non-executing plan without REA permission grants", async () => {
    const directory = await createTestTempDirectory("rea-managed-runtime-");
    const artifactPath = join(directory, "fixture.dll");
    const executablePath = process.execPath;
    const fixture = inspect(buildManagedPeFixture(), artifactPath);
    let configurationReads = 0;
    const result = await planManagedRuntimeCorrelationEvidence(
      {
        configuration: () => {
          configurationReads += 1;
          return { executablePath };
        },
      },
      {
        ...inputFor(fixture.evidence, fixture.method),
        bounds: {
          timeout_ms: 5_000,
          max_threads: 32,
          max_output_bytes: 65_536,
          allow_network: true,
          allow_ui: true,
        },
      },
    );

    expect(configurationReads).toBe(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.operation).toBe("plan_managed_runtime_correlation");
    expect(result.value.confidence).toBe("derived");
    expect(result.value.authority).toBe("analyst-inference");
    const plan = managedRuntimeCorrelationResultSchema.parse(
      result.value.normalized_result,
    );
    expect(
      managedRuntimeCorrelationInputSchema.safeParse({
        ...inputFor(fixture.evidence, fixture.method),
        bounds: {
          timeout_ms: 60_001,
          max_threads: 257,
          max_output_bytes: 1_048_577,
          allow_network: true,
          allow_ui: true,
        },
      }).success,
    ).toBe(true);
    expect(
      managedRuntimeCorrelationResultSchema.safeParse({
        ...plan,
        limitations: Array.from({ length: 1_001 }, () => "x".repeat(4_097)),
      }).success,
    ).toBe(true);
    expect(plan).toMatchObject({
      executed: false,
      method_lock: {
        token: "0x06000001",
        exact_build_required: true,
      },
      requested_runtime: {
        effect: "instrumentation",
        executable_path: executablePath,
        network: "host",
        confinement: "not-established",
      },
      effect_taxonomy: {
        instruments_code: true,
        invokes_target_code: false,
      },
      unsupported_until_executor_exists: true,
    });
  });

  it("rejects a method lock that no longer matches static Evidence", async () => {
    const directory = await createTestTempDirectory("rea-managed-runtime-");
    const artifactPath = join(directory, "fixture.dll");
    const executablePath = process.execPath;
    const fixture = inspect(buildManagedPeFixture(), artifactPath);
    const result = await planManagedRuntimeCorrelationEvidence(
      { configuration: () => ({ executablePath }) },
      {
        ...inputFor(fixture.evidence, fixture.method),
        method: {
          ...inputFor(fixture.evidence, fixture.method).method,
          normalized_il_sha256: "0".repeat(64),
        },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisInputError");
  });

  it("plans without probing or requiring an installed runtime executable", async () => {
    const fixture = inspect(
      buildManagedPeFixture(),
      "/tmp/managed-runtime.dll",
    );
    const result = await planManagedRuntimeCorrelationEvidence(
      { configuration: () => ({ executablePath: undefined }) },
      inputFor(fixture.evidence, fixture.method),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = managedRuntimeCorrelationResultSchema.parse(
      result.value.normalized_result,
    );
    expect(plan.executed).toBe(false);
    expect(plan.requested_runtime.executable_path).toBe("dotnet");
    expect(plan.limitations.join(" ")).toContain(
      "prerequisites are unverified",
    );
  });
});

const inputFor = (
  staticMembers: ReturnType<typeof createEvidence>,
  method: ReturnType<typeof inspect>["method"],
) => ({
  static_members: staticMembers,
  method: {
    token: method.token,
    signature_sha256: method.signature.raw_sha256,
    normalized_il_sha256: method.body.normalized_il_sha256,
  },
  requested_effect: "instrumentation" as const,
  host: {
    os: "linux" as const,
    clr_family: "dotnet" as const,
    architecture: "x86_64" as const,
  },
  bounds: {
    timeout_ms: 5_000,
    max_threads: 32,
    max_output_bytes: 65_536,
    allow_network: false as const,
    allow_ui: false as const,
  },
});

const inspect = (bytes: Buffer, path: string) => {
  const target = managedPeFixtureTarget(bytes, path);
  const result = inspectManagedMembersBytes(bytes, target);
  const method = result.methods[0];
  if (method === undefined) throw new Error("fixture has no method");
  return {
    result,
    method,
    evidence: createEvidence(target, MANAGED_STATIC_PROVIDER, {
      operation: "inspect_managed_members",
      parameters: {},
      result,
      rawResult: null,
      limitations: result.limitations,
    }),
  };
};
