import { createHash } from "node:crypto";
import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import type { AnalysisExecution } from "../../../../src/application/AnalysisProvider.js";
import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
import {
  managedArtifactInspectionSchema,
  managedMemberInspectionSchema,
  managedNativeBoundaryInspectionSchema,
} from "../../../../src/domain/managed/managedArtifact.js";
import { ManagedStaticProvider } from "../../../../src/dotnet/ManagedStaticProvider.js";
import { buildManagedPeFixture } from "../../../../src/dotnet/ManagedPe.fixture.js";
import {
  MAX_MANAGED_SNAPSHOT_BYTES,
  readManagedSnapshot,
} from "../../../../src/dotnet/ManagedSnapshot.js";
import { OwnedFileHandle } from "../../../../src/filesystem/OwnedFileHandle.js";
import { ArtifactResourceScope } from "../../../../src/artifacts/ArtifactResourceScope.js";
import { RegularFileCleanupFailure } from "../../../../src/application/RegularFileRead.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import * as boundedFileBytes from "../../../../src/process/BoundedFileBytes.js";

describe("managed static snapshot capacity failure", () => {
  it("preserves a typed capacity failure when closing the admitted file also fails", async () => {
    const directory = await createTestTempDirectory(
      "rea-managed-capacity-cleanup-",
    );
    const path = join(directory, "sparse.exe");
    await writeFile(path, Buffer.alloc(0));
    await truncate(path, MAX_MANAGED_SNAPSHOT_BYTES + 1);
    const resources = new ArtifactResourceScope();
    const originalClose = OwnedFileHandle.prototype.close;
    let permitClose = false;
    const owners: OwnedFileHandle[] = [];
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        owners.push(this);
        if (!permitClose) throw new Error("fixture handle close failure");
        await originalClose.call(this);
      });
    try {
      const failure = await readManagedSnapshot(
        path,
        "inspect_managed_artifact",
        {
          resources,
        },
      ).catch((cause: unknown) => cause);

      expect(failure).toMatchObject({
        cleanupIncomplete: true,
        cleanupResources: [path],
        diagnostics: { primary_error: { code: "resource_constraint" } },
      });
      expect(owners.length).toBeGreaterThan(0);
      expect(owners.every((owner) => owner === owners[0])).toBe(true);

      permitClose = true;
      await resources.close();
    } finally {
      permitClose = true;
      await resources.close();
      close.mockRestore();
    }
  });
});

describe("managed static snapshot cancellation", () => {
  it("preserves cancellation when snapshot cleanup also fails", async () => {
    const directory = await createTestTempDirectory(
      "rea-managed-cancel-cleanup-",
    );
    const path = join(directory, "fixture.exe");
    await writeFile(path, buildManagedPeFixture());
    const parsed = await parseBinaryTarget(path);
    if (!parsed.ok) throw parsed.error;
    const client = new ManagedStaticProvider().createClient(parsed.value);
    const controller = new AbortController();
    const originalRead = boundedFileBytes.readBoundedFileBytes;
    const read = vi
      .spyOn(boundedFileBytes, "readBoundedFileBytes")
      .mockImplementation(async (...arguments_) => {
        controller.abort(new Error("fixture cancellation"));
        return originalRead(...arguments_);
      });
    const originalClose = OwnedFileHandle.prototype.close;
    let permitClose = false;
    const owners: OwnedFileHandle[] = [];
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        owners.push(this);
        if (!permitClose) throw new Error("fixture handle close failure");
        await originalClose.call(this);
      });

    try {
      const result = await client.execute(
        "inspect_managed_artifact",
        {},
        { signal: controller.signal },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          diagnostics: {
            primary_error: { code: "cancelled" },
          },
        },
      });
      expect(result.error.cause).toBeInstanceOf(AggregateError);
      if (!(result.error.cause instanceof AggregateError)) return;
      const cleanupError = result.error.cause.errors[1];
      expect(cleanupError).toBeInstanceOf(Error);
      if (!(cleanupError instanceof Error)) return;
      expect(cleanupError.cause).toBeInstanceOf(RegularFileCleanupFailure);
      if (!(cleanupError.cause instanceof RegularFileCleanupFailure)) return;
      expect(cleanupError.cause.owner).toBe(owners[0]);
      expect(owners[0]?.handle.fd).toBeGreaterThanOrEqual(0);

      permitClose = true;
      expect(await client.close()).toMatchObject({ ok: true });
      expect(owners.every((owner) => owner === owners[0])).toBe(true);
    } finally {
      permitClose = true;
      await client.close();
      close.mockRestore();
      read.mockRestore();
    }
  });
});

describe("managed static file ownership", () => {
  it("retains the same failed file owner, blocks reads, and retries it on client close", async () => {
    const directory = await createTestTempDirectory("rea-managed-close-");
    const bytes = buildManagedPeFixture();
    const path = join(directory, "fixture.exe");
    await writeFile(path, bytes);
    const parsed = await parseBinaryTarget(path);
    if (!parsed.ok) throw parsed.error;
    const client = new ManagedStaticProvider().createClient(parsed.value);
    const originalClose = OwnedFileHandle.prototype.close;
    const owners: OwnedFileHandle[] = [];
    let permitClose = false;
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        owners.push(this);
        if (!permitClose) throw new Error("fixture handle close failure");
        await originalClose.call(this);
      });
    try {
      const failed = await client.execute("inspect_managed_artifact", {});
      expect(failed).toMatchObject({
        ok: false,
        error: {
          cleanupIncomplete: true,
          cleanupResources: [path],
        },
      });

      const blocked = await client.execute("inspect_managed_artifact", {});
      expect(blocked).toMatchObject({
        ok: false,
        error: {
          cleanupIncomplete: true,
          cleanupResources: [path],
        },
      });
      expect(owners).toHaveLength(3);
      expect(owners.every((owner) => owner === owners[0])).toBe(true);

      permitClose = true;
      expect(await client.close()).toMatchObject({ ok: true });
      expect(owners).toHaveLength(4);
      expect(owners.every((owner) => owner === owners[0])).toBe(true);
    } finally {
      permitClose = true;
      await client.close();
      close.mockRestore();
    }
  });
});

describe("managed static provider path boundary", () => {
  it("executes as a read-only auxiliary provider with digest, cancellation, and format boundaries", async () => {
    const directory = await createTestTempDirectory("rea-managed-provider-");
    const bytes = buildManagedPeFixture();
    const path = join(directory, "fixture.exe");
    await writeFile(path, bytes);
    const parsed = await parseBinaryTarget(path);
    if (!parsed.ok) throw parsed.error;

    const client = new ManagedStaticProvider().createClient(parsed.value);
    const observed = await client.execute("inspect_managed_artifact", {});
    if (!observed.ok) throw observed.error;
    expect(asManagedResult(observed.value)).toMatchObject({
      classification: { status: "managed", runtime_family: "modern-dotnet" },
      artifact: { path, sha256: parsed.value.sha256, format: "pe" },
    });
    expect(observed.value.provider.id).toBe("rea-dotnet-static");
    expect(observed.value.subject).toMatchObject({ path, format: "pe" });

    const members = await client.execute("inspect_managed_members", {});
    if (!members.ok) throw members.error;
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
    if (!boundaries.ok) throw boundaries.error;
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
    if (!parsed.ok) throw parsed.error;

    const client = new ManagedStaticProvider().createClient(parsed.value);
    const execution = await client.execute(
      "inspect_managed_native_boundaries",
      {},
    );
    if (!execution.ok) throw execution.error;
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

it("preserves custom attribute value evidence through the filesystem provider when its constructor is invalid", async () => {
  const directory = await createTestTempDirectory("rea-managed-attribute-");
  const path = join(directory, "fixture.exe");
  await writeFile(path, buildManagedPeFixture({ customAttributeTypeRaw: 19 }));
  const parsed = await parseBinaryTarget(path);
  if (!parsed.ok) throw parsed.error;
  const frameworkText = Buffer.from(".NETCoreApp,Version=v8.0", "utf8");
  const attributeValue = Buffer.concat([
    Buffer.from([1, 0, frameworkText.length]),
    frameworkText,
    Buffer.alloc(2),
  ]);
  const client = new ManagedStaticProvider().createClient(parsed.value);
  try {
    const execution = await client.execute("inspect_managed_artifact", {});
    if (!execution.ok) throw execution.error;

    const result = asManagedResult(execution.value);
    expect(result).toMatchObject({
      attributes: [
        {
          parent_token: "0x20000001",
          constructor_token: null,
          type_name: null,
          value_length: attributeValue.length,
          value_sha256: createHash("sha256")
            .update(attributeValue)
            .digest("hex"),
          token: "0x0c000001",
        },
      ],
      coverage: {
        state: "partial",
      },
    });
    const attribute = result.attributes[0];
    if (attribute === undefined) throw new Error("Fixture omitted attribute");
    expect(result.coverage.issues).toEqual([
      expect.objectContaining({
        code: "invalid-row",
        scope: "metadata.CustomAttribute:0x0c000001",
        offset: attribute.row_offset + 2,
        detail:
          "CustomAttribute constructor coded index 0x13 is invalid: coded index selects row 2 in table 10, which has 1 rows",
      }),
    ]);
  } finally {
    await client.close();
  }
});

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
  if (!parsed.ok) throw parsed.error;
  const client = new ManagedStaticProvider().createClient(parsed.value);
  const artifact = await client.execute("inspect_managed_artifact", {});
  if (!artifact.ok) throw artifact.error;
  expect(asManagedResult(artifact.value)).toMatchObject({
    references: [expect.objectContaining({ name: "\uFEFFSystem.Runtime" })],
    target_frameworks: ["\uFEFF.NETCoreApp,Version=v8.0"],
  });
  const members = await client.execute("inspect_managed_members", {});
  if (!members.ok) throw members.error;
  expect(asManagedMemberResult(members.value)).toMatchObject({
    types: [expect.objectContaining({ name: "\uFEFFProgram" })],
    methods: [expect.objectContaining({ name: "\uFEFFMain" })],
    fields: [expect.objectContaining({ name: "\uFEFFcounter" })],
  });
});

it("keeps non-CIL implementation bytes unknown through the real file provider", async () => {
  const directory = await createTestTempDirectory("rea-managed-native-body-");
  const path = join(directory, "fixture.exe");
  const bytes = buildManagedPeFixture();
  await writeFile(path, bytes);
  const originalTarget = await parseBinaryTarget(path);
  if (!originalTarget.ok) throw originalTarget.error;
  const original = await new ManagedStaticProvider()
    .createClient(originalTarget.value)
    .execute("inspect_managed_members", {});
  if (!original.ok) throw original.error;
  const row = asManagedMemberResult(original.value).methods[0]?.row_offset;
  expect(row).toBeDefined();
  if (row === undefined) return;
  bytes.writeUInt16LE(1, row + 4);
  await writeFile(path, bytes);
  const nativeTarget = await parseBinaryTarget(path);
  if (!nativeTarget.ok) throw nativeTarget.error;
  const native = await new ManagedStaticProvider()
    .createClient(nativeTarget.value)
    .execute("inspect_managed_members", {});
  if (!native.ok) throw native.error;
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
  if (!absentTarget.ok) throw absentTarget.error;
  const absent = await new ManagedStaticProvider()
    .createClient(absentTarget.value)
    .execute("inspect_managed_members", {});
  if (!absent.ok) throw absent.error;
  expect(asManagedMemberResult(absent.value).methods[0]?.body.status).toBe(
    "absent",
  );
});
