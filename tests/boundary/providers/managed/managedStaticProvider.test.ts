import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import type { AnalysisExecution } from "../../../../src/application/AnalysisProvider.js";
import { parseBinaryTarget } from "../../../../src/domain/binaryTarget.js";
import {
  managedArtifactInspectionSchema,
  managedMemberInspectionSchema,
  managedNativeBoundaryInspectionSchema,
} from "../../../../src/domain/managedArtifact.js";
import { ManagedStaticProvider } from "../../../../src/dotnet/ManagedStaticProvider.js";
import { buildManagedPeFixture } from "../../../../src/dotnet/ManagedPe.fixture.js";

describe("managed static provider path boundary", () => {
  it("executes as a read-only auxiliary provider with digest, cancellation, and format boundaries", async () => {
    const directory = await createTestTempDirectory("rea-managed-provider-");
    const bytes = buildManagedPeFixture();
    const path = join(directory, "fixture.exe");
    await writeFile(path, bytes);
    const parsed = await parseBinaryTarget(path);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const client = new ManagedStaticProvider().createClient(parsed.value);
    const observed = await client.execute("inspect_managed_artifact", {});
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    expect(asManagedResult(observed.value)).toMatchObject({
      classification: { status: "managed", runtime_family: "modern-dotnet" },
      artifact: { path, sha256: parsed.value.sha256, format: "pe" },
    });
    expect(observed.value.provider.id).toBe("rea-dotnet-static");
    expect(observed.value.subject).toMatchObject({ path, format: "pe" });

    const members = await client.execute("inspect_managed_members", {});
    expect(members.ok).toBe(true);
    if (!members.ok) return;
    expect(asManagedMemberResult(members.value)).toMatchObject({
      artifact: { path, sha256: parsed.value.sha256, format: "pe" },
      methods: { total: 1 },
      call_edges: { total: 1 },
      field_accesses: { total: 1 },
    });

    const boundaries = await client.execute(
      "inspect_managed_native_boundaries",
      {},
    );
    expect(boundaries.ok).toBe(true);
    if (!boundaries.ok) return;
    expect(asManagedNativeBoundaryResult(boundaries.value)).toMatchObject({
      artifact: { path, sha256: parsed.value.sha256, format: "pe" },
      module_refs: { total: 0 },
      pinvoke_imports: { total: 0 },
      native_implementations: { total: 0 },
    });

    const cancelled = new AbortController();
    cancelled.abort();
    const cancelledResult = await client.execute(
      "inspect_managed_artifact",
      {},
      { signal: cancelled.signal },
    );
    expect(cancelledResult).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });

    const changed = Buffer.from(bytes);
    changed[0x300] = 0;
    await writeFile(path, changed);
    const staleDigest = await client.execute("inspect_managed_artifact", {});
    expect(staleDigest).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceIntegrityError" },
    });

    await client.close();
    const nativeClient = new ManagedStaticProvider().createClient({
      path: parsed.value.path,
      sha256: parsed.value.sha256,
      kind: "executable",
      format: "elf",
      architecture: "x86",
      availableArchitectures: ["x86"],
    });
    await expect(
      nativeClient.execute("inspect_managed_artifact", {}),
    ).resolves.toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCapabilityUnavailableError" },
    });
  });
});
const asManagedResult = (execution: AnalysisExecution) =>
  managedArtifactInspectionSchema.parse(execution.result);

const asManagedMemberResult = (execution: AnalysisExecution) =>
  managedMemberInspectionSchema.parse(execution.result);

const asManagedNativeBoundaryResult = (execution: AnalysisExecution) =>
  managedNativeBoundaryInspectionSchema.parse(execution.result);
