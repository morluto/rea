import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runProviderAnalysis } from "../src/application/DirectAnalysis.js";
import type { AnalysisExecution } from "../src/application/AnalysisProvider.js";
import {
  managedArtifactInspectionSchema,
  managedMemberInspectionSchema,
  managedNativeBoundaryInspectionSchema,
} from "../src/domain/managedArtifact.js";
import type { BinaryTarget } from "../src/domain/binaryTarget.js";
import { parseBinaryTarget } from "../src/domain/binaryTarget.js";
import { parseEvidence } from "../src/domain/evidence.js";
import { ManagedStaticProvider } from "../src/dotnet/ManagedStaticProvider.js";
import { inspectManagedArtifactBytes } from "../src/dotnet/ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "../src/dotnet/ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "../src/dotnet/ManagedNativeBoundaryInspector.js";
import {
  buildManagedPeFixture,
  buildNativePeFixture,
} from "./fixtures/managedPe.js";

const limits = {
  referenceOffset: 0,
  referenceLimit: 100,
  resourceOffset: 0,
  resourceLimit: 100,
  attributeOffset: 0,
  attributeLimit: 100,
  maxMetadataBytes: 1024 * 1024,
  maxTableRows: 1_000,
  maxHeapItemBytes: 1024 * 1024,
};

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

const nativeBoundaryLimits = {
  moduleRefOffset: 0,
  moduleRefLimit: 100,
  importOffset: 0,
  importLimit: 100,
  implementationOffset: 0,
  implementationLimit: 100,
  maxMetadataBytes: 1024 * 1024,
  maxTableRows: 1_000,
  maxHeapItemBytes: 1024 * 1024,
};

describe("managed PE/CLI static provider", () => {
  it("inventories module, assembly, framework, references, and resources without loading CLR code", () => {
    const resource = Buffer.from("source-owned resource");
    const bytes = buildManagedPeFixture({ resourceData: resource });
    const result = inspectManagedArtifactBytes(bytes, target(bytes), limits);

    expect(result.classification).toMatchObject({
      status: "managed",
      runtime_family: "modern-dotnet",
      implementation: "cil",
      managed_architecture: "anycpu",
    });
    expect(result.pe.cli).toMatchObject({
      flag_names: ["il-only"],
      entry_point: { kind: "metadata-token", value: "0x06000001" },
    });
    expect(result.module).toMatchObject({
      name: "Fixture.dll",
      mvid: "00112233-4455-6677-8899-aabbccddeeff",
      token: "0x00000001",
    });
    expect(result.assembly).toMatchObject({
      name: "Fixture.Managed",
      version: "1.2.3.4",
      token: "0x20000001",
    });
    expect(result.target_frameworks).toEqual([".NETCoreApp,Version=v8.0"]);
    expect(result.references).toMatchObject({
      total: 1,
      returned: 1,
      complete: true,
      items: [expect.objectContaining({ name: "System.Runtime" })],
    });
    expect(result.resources.items).toEqual([
      expect.objectContaining({
        name: "Fixture.resources",
        embedded: true,
        visibility: "private",
        data_length: resource.length,
        data_sha256: createHash("sha256").update(resource).digest("hex"),
      }),
    ]);
    expect(result.coverage).toMatchObject({ state: "complete", issues: [] });
  });

  it("keeps classification evidence complete when caller pages visible references", () => {
    const bytes = buildManagedPeFixture({
      references: ["System.Runtime", "UnityEngine.CoreModule"],
    });
    const result = inspectManagedArtifactBytes(bytes, target(bytes), {
      ...limits,
      referenceLimit: 1,
    });

    expect(result.classification.runtime_family).toBe("unity-mono");
    expect(result.references).toMatchObject({
      total: 2,
      returned: 1,
      complete: false,
    });
    expect(result.coverage.state).toBe("partial");
    expect(result.coverage.issues).toEqual([]);
  });

  it("inspects metadata members, signatures, CIL hashes, call edges, and field anchors", () => {
    const bytes = buildManagedPeFixture();
    const result = inspectManagedMembersBytes(
      bytes,
      target(bytes),
      memberLimits,
    );

    expect(result.identity_scope).toEqual({
      token_identity: "build-local",
      requires_artifact_sha256: target(bytes).sha256,
      requires_mvid: "00112233-4455-6677-8899-aabbccddeeff",
    });
    expect(result.types.items).toEqual([
      expect.objectContaining({
        token: "0x02000001",
        full_name: "Fixture.Program",
        field_list: { first_row: 1, last_row: 1, count: 1 },
        method_list: { first_row: 1, last_row: 1, count: 1 },
      }),
    ]);
    expect(result.fields.items).toEqual([
      expect.objectContaining({
        token: "0x04000001",
        declaring_type: "Fixture.Program",
        name: "counter",
        signature: expect.objectContaining({
          kind: "field",
          parse_status: "decoded",
          field_type: "i4",
        }),
      }),
    ]);
    expect(result.methods.items).toEqual([
      expect.objectContaining({
        token: "0x06000001",
        declaring_type: "Fixture.Program",
        name: "Main",
        rva: 0x2800,
        signature: expect.objectContaining({
          kind: "method",
          parse_status: "decoded",
          return_type: "void",
          parameter_types: [],
        }),
        body: expect.objectContaining({
          status: "present",
          header_format: "tiny",
          file_offset: 0x0a00,
          il_size: 12,
          instruction_count: 4,
          decoded_instruction_count: 4,
          truncated_instructions: 0,
          opcode_counts: { "ldarg.0": 1, ldfld: 1, call: 1, ret: 1 },
          anchors: [
            {
              il_offset: 1,
              opcode: "ldfld",
              operand_kind: "field",
              operand: "0x04000001",
            },
            {
              il_offset: 6,
              opcode: "call",
              operand_kind: "method",
              operand: "0x0a000001",
            },
          ],
        }),
      }),
    ]);
    expect(result.member_refs.items).toEqual([
      expect.objectContaining({
        token: "0x0a000001",
        name: ".ctor",
        signature: expect.objectContaining({
          kind: "method",
          parse_status: "decoded",
          parameter_types: ["string"],
        }),
      }),
    ]);
    expect(result.call_edges.items).toEqual([
      {
        caller_token: "0x06000001",
        caller: "Fixture.Program.Main",
        opcode: "call",
        target_token: "0x0a000001",
        target_kind: "member-ref",
        target_name: ".ctor",
      },
    ]);
    expect(result.field_accesses.items).toEqual([
      {
        method_token: "0x06000001",
        method: "Fixture.Program.Main",
        opcode: "ldfld",
        field_token: "0x04000001",
        field_name: "counter",
      },
    ]);
    expect(result.coverage).toMatchObject({ state: "complete", issues: [] });
  });

  it("inspects managed/native PInvoke declarations without verifying native exports", () => {
    const bytes = buildManagedPeFixture({
      pinvoke: {
        moduleName: "user32.dll",
        importName: "MessageBoxW",
        mappingFlags: 0x0345,
      },
      readyToRun: true,
    });
    const result = inspectManagedNativeBoundariesBytes(
      bytes,
      target(bytes),
      nativeBoundaryLimits,
    );

    expect(result.cli_native).toMatchObject({
      il_only: true,
      ready_to_run_signature: true,
      managed_native_header_rva: 0x2700,
      managed_native_header_size: 4,
    });
    expect(result.module_refs.items).toEqual([
      {
        token: "0x1a000001",
        row_offset: expect.any(Number),
        name: "user32.dll",
      },
    ]);
    expect(result.pinvoke_imports.items).toEqual([
      expect.objectContaining({
        token: "0x1c000001",
        member_token: "0x06000001",
        member_kind: "method",
        member_name: "Main",
        import_name: "MessageBoxW",
        import_scope_token: "0x1a000001",
        import_scope_name: "user32.dll",
        no_mangle: true,
        char_set: "unicode",
        call_convention: "stdcall",
        supports_last_error: true,
        verification: "managed-declaration-only",
      }),
    ]);
    expect(result.native_implementations.items).toEqual([
      expect.objectContaining({
        token: "0x06000001",
        name: "Main",
        pinvoke_declared: true,
        boundary_kind: "pinvoke",
        body_interpretation: "native-or-runtime",
      }),
    ]);
    expect(result.summary).toMatchObject({
      module_ref_count: 1,
      pinvoke_import_count: 1,
      native_implementation_count: 1,
      ready_to_run: true,
      mixed_mode_or_native_header: true,
    });
    expect(result.limitations).toContain(
      "P/Invoke rows prove managed import declarations only; this inspection does not verify that a native library, export, thunk, or provider-qualified function exists.",
    );
  });

  it("keeps member evidence bounded and typed for pagination and unavailable metadata", () => {
    const bytes = buildManagedPeFixture();
    const paged = inspectManagedMembersBytes(bytes, target(bytes), {
      ...memberLimits,
      methodLimit: 0 + 1,
      instructionAnchorLimit: 1,
    });
    expect(paged.methods).toMatchObject({
      total: 1,
      returned: 1,
      complete: true,
    });
    expect(paged.methods.items[0]?.body.anchors).toHaveLength(1);

    const nativeBytes = buildNativePeFixture();
    const native = inspectManagedMembersBytes(
      nativeBytes,
      target(nativeBytes),
      memberLimits,
    );
    expect(native.metadata.status).toBe("absent");
    expect(native.coverage.state).toBe("unavailable");

    const malformedBytes = buildManagedPeFixture({
      corruptMetadataSignature: true,
    });
    const malformed = inspectManagedMembersBytes(
      malformedBytes,
      target(malformedBytes),
      memberLimits,
    );
    expect(malformed.metadata.status).toBe("malformed");
    expect(malformed.coverage.issues).toEqual([
      expect.objectContaining({ code: "invalid-metadata-root" }),
    ]);
  });

  it("reports native PE, malformed metadata, and bounded metadata failures as typed results", () => {
    const native = inspectManagedArtifactBytes(
      buildNativePeFixture(),
      target(buildNativePeFixture()),
      limits,
    );
    expect(native.classification.status).toBe("not-managed");
    expect(native.metadata.status).toBe("absent");
    expect(native.coverage.state).toBe("unavailable");

    const malformedBytes = buildManagedPeFixture({
      corruptMetadataSignature: true,
    });
    const malformed = inspectManagedArtifactBytes(
      malformedBytes,
      target(malformedBytes),
      limits,
    );
    expect(malformed.classification.status).toBe("malformed");
    expect(malformed.coverage.issues).toEqual([
      expect.objectContaining({ code: "invalid-metadata-root" }),
    ]);

    const unsupportedTableBytes = buildManagedPeFixture({
      metadataValidMaskExtra: 1n << 50n,
    });
    const unsupportedTable = inspectManagedArtifactBytes(
      unsupportedTableBytes,
      target(unsupportedTableBytes),
      limits,
    );
    expect(unsupportedTable.coverage.issues).toEqual([
      expect.objectContaining({ code: "invalid-tables" }),
    ]);

    const limited = inspectManagedArtifactBytes(
      buildManagedPeFixture(),
      target(buildManagedPeFixture()),
      { ...limits, maxMetadataBytes: 256 },
    );
    expect(limited.metadata.status).toBe("partial");
    expect(limited.coverage.issues).toEqual([
      expect.objectContaining({ code: "limit-exceeded" }),
    ]);
  });

  it("executes as a read-only auxiliary provider with digest, cancellation, and format boundaries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-managed-provider-"));
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
      ...parsed.value,
      format: "elf",
    });
    await expect(
      nativeClient.execute("inspect_managed_artifact", {}),
    ).resolves.toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCapabilityUnavailableError" },
    });
  });

  it("has the same evidence shape through direct CLI analysis plumbing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-managed-cli-"));
    const path = join(directory, "fixture.exe");
    await writeFile(path, buildManagedPeFixture());

    const evidence = parseEvidence(
      await runProviderAnalysis(path, "inspect_managed_artifact", {
        reference_limit: 1,
      }),
    );
    expect(evidence).toMatchObject({
      operation: "inspect_managed_artifact",
      provider: { id: "rea-dotnet-static" },
      subject: { local_path: path, format: "pe" },
      normalized_result: {
        classification: { status: "managed", runtime_family: "modern-dotnet" },
        references: { limit: 1 },
      },
    });

    const memberEvidence = parseEvidence(
      await runProviderAnalysis(path, "inspect_managed_members", {}),
    );
    expect(memberEvidence).toMatchObject({
      operation: "inspect_managed_members",
      provider: { id: "rea-dotnet-static" },
      subject: { local_path: path, format: "pe" },
      normalized_result: {
        identity_scope: { token_identity: "build-local" },
        methods: { total: 1 },
      },
    });

    const boundaryEvidence = parseEvidence(
      await runProviderAnalysis(path, "inspect_managed_native_boundaries", {}),
    );
    expect(boundaryEvidence).toMatchObject({
      operation: "inspect_managed_native_boundaries",
      provider: { id: "rea-dotnet-static" },
      subject: { local_path: path, format: "pe" },
      normalized_result: {
        identity_scope: { token_identity: "build-local" },
        pinvoke_imports: { total: 0 },
      },
    });
  });
});

const target = (bytes: Buffer): BinaryTarget => ({
  path: "/fixture.exe",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  kind: "executable",
  format: "pe",
  architecture: "x86",
  availableArchitectures: ["x86"],
});

const asManagedResult = (execution: AnalysisExecution) =>
  managedArtifactInspectionSchema.parse(execution.result);

const asManagedMemberResult = (execution: AnalysisExecution) =>
  managedMemberInspectionSchema.parse(execution.result);

const asManagedNativeBoundaryResult = (execution: AnalysisExecution) =>
  managedNativeBoundaryInspectionSchema.parse(execution.result);
