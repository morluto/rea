import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import type { AnalysisExecution } from "../../../../src/application/AnalysisProvider.js";
import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
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
      methods: [expect.objectContaining({ token: "0x06000001" })],
      call_edges: [expect.objectContaining({ target_name: ".ctor" })],
      field_accesses: [expect.objectContaining({ field_name: "counter" })],
    });
    const memberResult = asManagedMemberResult(members.value);
    expect(members.value.locations).toEqual(
      expect.arrayContaining(
        memberResult.methods.flatMap((method) =>
          method.body.file_offset === null
            ? []
            : [{ kind: "file-offset", offset: method.body.file_offset }],
        ),
      ),
    );

    const boundaries = await client.execute(
      "inspect_managed_native_boundaries",
      {},
    );
    expect(boundaries.ok).toBe(true);
    if (!boundaries.ok) return;
    const boundaryResult = asManagedNativeBoundaryResult(boundaries.value);
    expect(boundaryResult).toMatchObject({
      artifact: { path, sha256: parsed.value.sha256, format: "pe" },
      module_refs: [],
      pinvoke_imports: [],
      native_implementations: [],
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

  it("retains a source location for every managed P/Invoke mapping", async () => {
    const directory = await createTestTempDirectory("rea-managed-pinvoke-");
    const bytes = buildManagedPeFixture({
      pinvoke: { moduleName: "user32.dll", importName: "MessageBoxW" },
    });
    const path = join(directory, "fixture.exe");
    await writeFile(path, bytes);
    const parsed = await parseBinaryTarget(path);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const client = new ManagedStaticProvider().createClient(parsed.value);
    const execution = await client.execute(
      "inspect_managed_native_boundaries",
      {},
    );
    expect(execution.ok).toBe(true);
    if (!execution.ok) return;
    const result = asManagedNativeBoundaryResult(execution.value);
    expect(result.pinvoke_imports.length).toBeGreaterThan(0);
    expect(execution.value.locations).toEqual(
      expect.arrayContaining(
        result.pinvoke_imports.map((mapping) => ({
          kind: "file-offset",
          offset: mapping.row_offset,
        })),
      ),
    );
    await client.close();
  });
});
const asManagedResult = (execution: AnalysisExecution) =>
  managedArtifactInspectionSchema.parse(execution.result);

const asManagedMemberResult = (execution: AnalysisExecution) =>
  managedMemberInspectionSchema.parse(execution.result);

const asManagedNativeBoundaryResult = (execution: AnalysisExecution) =>
  managedNativeBoundaryInspectionSchema.parse(execution.result);

it("retains U+FEFF metadata through the filesystem target and provider", async () => {
  const directory = await createTestTempDirectory("rea-managed-bom-");
  const path = join(directory, "fixture.exe");
  await writeFile(
    path,
    buildManagedPeFixture({
      typeName: "\uFEFFProgram",
      methodName: "\uFEFFMain",
      fieldName: "\uFEFFcounter",
      references: ["\uFEFFSystem.Runtime"],
      targetFramework: "\uFEFF.NETCoreApp,Version=v8.0",
    }),
  );
  const parsed = await parseBinaryTarget(path);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const client = new ManagedStaticProvider().createClient(parsed.value);
  const artifact = await client.execute("inspect_managed_artifact", {});
  expect(artifact.ok).toBe(true);
  if (!artifact.ok) return;
  expect(asManagedResult(artifact.value)).toMatchObject({
    references: [expect.objectContaining({ name: "\uFEFFSystem.Runtime" })],
    target_frameworks: ["\uFEFF.NETCoreApp,Version=v8.0"],
  });
  const members = await client.execute("inspect_managed_members", {});
  expect(members.ok).toBe(true);
  if (!members.ok) return;
  expect(asManagedMemberResult(members.value)).toMatchObject({
    types: [expect.objectContaining({ name: "\uFEFFProgram" })],
    methods: [expect.objectContaining({ name: "\uFEFFMain" })],
    fields: [expect.objectContaining({ name: "\uFEFFcounter" })],
  });
});
