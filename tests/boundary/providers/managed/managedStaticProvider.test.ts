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

it("keeps non-CIL implementation bytes unknown through the real file provider", async () => {
  const directory = await createTestTempDirectory("rea-managed-native-body-");
  const path = join(directory, "fixture.exe");
  const bytes = buildManagedPeFixture();
  await writeFile(path, bytes);
  const originalTarget = await parseBinaryTarget(path);
  expect(originalTarget.ok).toBe(true);
  if (!originalTarget.ok) return;
  const original = await new ManagedStaticProvider()
    .createClient(originalTarget.value)
    .execute("inspect_managed_members", {});
  expect(original.ok).toBe(true);
  if (!original.ok) return;
  const row = asManagedMemberResult(original.value).methods[0]?.row_offset;
  expect(row).toBeDefined();
  if (row === undefined) return;
  bytes.writeUInt16LE(1, row + 4);
  await writeFile(path, bytes);
  const nativeTarget = await parseBinaryTarget(path);
  expect(nativeTarget.ok).toBe(true);
  if (!nativeTarget.ok) return;
  const native = await new ManagedStaticProvider()
    .createClient(nativeTarget.value)
    .execute("inspect_managed_members", {});
  expect(native.ok).toBe(true);
  if (!native.ok) return;
  const result = asManagedMemberResult(native.value);
  expect(result.methods[0]?.body).toMatchObject({
    status: "partial",
    rva: 0x2800,
    il_sha256: null,
    anchors: [],
  });
  expect(result.call_edges).toEqual([]);
  expect(result.field_accesses).toEqual([]);
  bytes.writeUInt32LE(0, row);
  await writeFile(path, bytes);
  const absentTarget = await parseBinaryTarget(path);
  expect(absentTarget.ok).toBe(true);
  if (!absentTarget.ok) return;
  const absent = await new ManagedStaticProvider()
    .createClient(absentTarget.value)
    .execute("inspect_managed_members", {});
  expect(absent.ok).toBe(true);
  if (!absent.ok) return;
  expect(asManagedMemberResult(absent.value).methods[0]?.body.status).toBe(
    "absent",
  );
});
