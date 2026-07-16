import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  planManagedRuntimeCorrelationEvidence,
  type ManagedRuntimePolicy,
} from "../src/application/ManagedRuntimeCorrelationService.js";
import { MANAGED_STATIC_PROVIDER } from "../src/application/InvestigationProviders.js";
import { createPermissionAuthority } from "../src/application/PermissionAuthority.js";
import { createEvidence } from "../src/domain/evidence.js";
import { managedRuntimeCorrelationResultSchema } from "../src/domain/managedRuntimeCorrelation.js";
import type { BinaryTarget } from "../src/domain/binaryTarget.js";
import type { PermissionCeiling } from "../src/domain/permissionPolicy.js";
import { inspectManagedMembersBytes } from "../src/dotnet/ManagedMemberInspector.js";
import { buildManagedPeFixture } from "./fixtures/managedPe.js";

const memberLimits = {
  typeOffset: 0,
  typeLimit: 100,
  methodOffset: 0,
  methodLimit: 100,
  fieldOffset: 0,
  fieldLimit: 100,
  memberRefOffset: 0,
  memberRefLimit: 100,
  edgeOffset: 0,
  edgeLimit: 100,
  instructionAnchorLimit: 100,
  maxMetadataBytes: 1024 * 1024,
  maxTableRows: 1_000,
  maxHeapItemBytes: 1024 * 1024,
  maxMethodBodyBytes: 1024 * 1024,
  maxMethodInstructions: 1_000,
};

describe("managed runtime correlation planning", () => {
  it("fails closed while the managed runtime authority is disabled", async () => {
    const fixture = inspect(buildManagedPeFixture(), "/tmp/disabled.dll");
    const result = await planManagedRuntimeCorrelationEvidence(
      {
        policy: disabledPolicy,
        authority: undefined,
      },
      inputFor(fixture.evidence, fixture.method),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisCapabilityUnavailableError");
  });

  it("requires an explicit managed_runtime grant under an enabled ceiling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-managed-runtime-"));
    const artifactPath = join(directory, "fixture.dll");
    const executablePath = join(directory, "dotnet");
    await writeFile(artifactPath, buildManagedPeFixture());
    await writeFile(executablePath, "#!/bin/sh\n");
    const fixture = inspect(buildManagedPeFixture(), artifactPath);
    const authority = await authorityFor(directory, executablePath, false);
    const result = await planManagedRuntimeCorrelationEvidence(
      {
        policy: { enabled: true, roots: [directory], executablePath },
        authority,
      },
      inputFor(fixture.evidence, fixture.method),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("PermissionRequiredError");
  });

  it("records an exact-build non-executing admission plan when authorized", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-managed-runtime-"));
    const artifactPath = join(directory, "fixture.dll");
    const executablePath = join(directory, "dotnet");
    await writeFile(artifactPath, buildManagedPeFixture());
    await writeFile(executablePath, "#!/bin/sh\n");
    const fixture = inspect(buildManagedPeFixture(), artifactPath);
    const policy = { enabled: true, roots: [directory], executablePath };
    const authority = await authorityFor(directory, executablePath, true);
    const result = await planManagedRuntimeCorrelationEvidence(
      { policy, authority },
      inputFor(fixture.evidence, fixture.method),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.operation).toBe("plan_managed_runtime_correlation");
    expect(result.value.confidence).toBe("derived");
    expect(result.value.authority).toBe("analyst-inference");
    const plan = managedRuntimeCorrelationResultSchema.parse(
      result.value.normalized_result,
    );
    expect(plan).toMatchObject({
      executed: false,
      authority_model: {
        capability: "managed_runtime",
        default_enabled: false,
        per_call_approval_required: true,
      },
      method_lock: {
        token: "0x06000001",
        exact_build_required: true,
      },
      requested_runtime: {
        effect: "instrumentation",
        executable_path: executablePath,
        network: "none",
      },
      effect_taxonomy: {
        instruments_code: true,
        invokes_target_code: false,
      },
      unsupported_until_executor_exists: true,
    });
  });

  it("rejects a method lock that no longer matches static Evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-managed-runtime-"));
    const artifactPath = join(directory, "fixture.dll");
    const executablePath = join(directory, "dotnet");
    await writeFile(artifactPath, buildManagedPeFixture());
    await writeFile(executablePath, "#!/bin/sh\n");
    const fixture = inspect(buildManagedPeFixture(), artifactPath);
    const authority = await authorityFor(directory, executablePath, true);
    const result = await planManagedRuntimeCorrelationEvidence(
      {
        policy: { enabled: true, roots: [directory], executablePath },
        authority,
      },
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
});

const disabledPolicy: ManagedRuntimePolicy = {
  enabled: false,
  roots: [],
  executablePath: "/usr/bin/dotnet",
};

const authorityFor = async (
  root: string,
  executablePath: string,
  granted: boolean,
) => {
  const ceiling: PermissionCeiling = {
    capability: "managed_runtime",
    roots: [root],
    executables: [executablePath],
    environment_names: [],
    network: "none",
    mount: false,
  };
  const authority = await createPermissionAuthority(
    [ceiling],
    granted
      ? [
          {
            ...ceiling,
            grant_id: "administrator:managed_runtime",
            lifetime: "administrator",
            operation_identity: null,
            expires_at: null,
          },
        ]
      : [],
  );
  if (!authority.ok) throw authority.error;
  return authority.value;
};

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
  const target: BinaryTarget = {
    path,
    sha256: hash(bytes),
    kind: "executable",
    format: "pe",
    architecture: "x86",
  };
  const result = inspectManagedMembersBytes(bytes, target, memberLimits);
  const method = result.methods.items[0];
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

const hash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
