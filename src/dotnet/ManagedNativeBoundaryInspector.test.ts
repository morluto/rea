import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "./ManagedNativeBoundaryInspector.js";
import {
  buildManagedPeFixture,
  buildNativePeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

describe("managed native boundaries", () => {
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
      managedPeFixtureTarget(bytes),
    );

    expect(result.cli_native).toMatchObject({
      il_only: true,
      ready_to_run_signature: true,
      managed_native_header_rva: 0x2700,
      managed_native_header_size: 4,
    });
    expect(result.module_refs).toEqual([
      {
        token: "0x1a000001",
        row_offset: expect.any(Number),
        name: "user32.dll",
      },
    ]);
    expect(result.pinvoke_imports).toEqual([
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
    expect(result.native_implementations).toEqual([
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
    expect(result.coverage).toMatchObject({ state: "complete", issues: [] });
    expect(result.limitations).toContain(
      "P/Invoke rows prove managed import declarations only; this inspection does not verify that a native library, export, thunk, or provider-qualified function exists.",
    );
  });
});

describe("managed native boundary coded indexes", () => {
  it("retains P/Invoke imports with an invalid MemberForwarded index as partial evidence", () => {
    const bytes = buildManagedPeFixture({
      pinvoke: { memberForwardedRaw: 5 },
    });
    const result = inspectManagedNativeBoundariesBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.pinvoke_imports).toMatchObject([
      {
        member_token: null,
        member_kind: "unknown",
        member_name: null,
        import_name: "MessageBoxW",
      },
    ]);
    expect(result.coverage).toMatchObject({
      state: "partial",
      issues: [
        expect.objectContaining({
          code: "invalid-row",
          scope: "metadata.ImplMap:0x1c000001",
          detail: expect.stringContaining(
            "coded index 0x5 is invalid: coded index selects row 2 in table 6, which has 1 rows",
          ),
        }),
      ],
    });
    expect(result.coverage.issues[0]?.offset).toBe(
      (result.pinvoke_imports[0]?.row_offset ?? 0) + 2,
    );
  });

  it("reports null for the required MemberForwarded index", () => {
    const bytes = buildManagedPeFixture({
      pinvoke: { memberForwardedRaw: 0 },
    });
    const result = inspectManagedNativeBoundariesBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.pinvoke_imports).toMatchObject([
      { member_token: null, member_kind: "unknown" },
    ]);
    expect(result.coverage).toMatchObject({
      state: "partial",
      issues: [
        expect.objectContaining({
          code: "invalid-row",
          detail:
            "ImplMap MemberForwarded coded index 0x0 is null, but the column must reference a Field or MethodDef row",
        }),
      ],
    });
  });
});

it.each([0, 2])(
  "retains imports and reports invalid ModuleRef row %i as partial",
  (scopeRow) => {
    const bytes = buildManagedPeFixture({ pinvoke: {} });
    const original = inspectManagedNativeBoundariesBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    const row = original.pinvoke_imports[0]?.row_offset;
    if (row === undefined) throw new Error("Fixture must contain an ImplMap");
    bytes.writeUInt16LE(scopeRow, row + 6);
    const result = inspectManagedNativeBoundariesBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    expect(result.pinvoke_imports).toMatchObject([
      {
        import_name: "MessageBoxW",
        import_scope_token: null,
        import_scope_name: null,
      },
    ]);
    expect(result.coverage).toMatchObject({
      state: "partial",
      issues: [
        expect.objectContaining({
          scope: "metadata.ImplMap:0x1c000001",
          offset: row + 6,
          detail: expect.stringContaining("ImportScope"),
        }),
      ],
    });
  },
);

it("reports field imports as declarations without inventing method implementations", () => {
  const bytes = buildManagedPeFixture({ pinvoke: { memberForwardedRaw: 2 } });
  const result = inspectManagedNativeBoundariesBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );
  expect(result.pinvoke_imports).toMatchObject([
    {
      member_kind: "field",
      member_token: "0x04000001",
      member_name: "counter",
    },
  ]);
  expect(
    result.native_implementations.every((item) =>
      item.token.startsWith("0x06"),
    ),
  ).toBe(true);
});

describe("managed native boundary inspection", () => {
  it("returns complete member inventories inline and reports unavailable metadata", () => {
    const bytes = buildManagedPeFixture();
    const paged = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    expect(paged.methods).toHaveLength(1);

    const nativeBytes = buildNativePeFixture();
    const native = inspectManagedMembersBytes(
      nativeBytes,
      managedPeFixtureTarget(nativeBytes),
    );
    expect(native.metadata.status).toBe("absent");
    expect(native.coverage.state).toBe("unavailable");

    const malformedBytes = buildManagedPeFixture({
      corruptMetadataSignature: true,
    });
    const malformed = inspectManagedMembersBytes(
      malformedBytes,
      managedPeFixtureTarget(malformedBytes),
    );
    expect(malformed.metadata.status).toBe("malformed");
    expect(malformed.coverage.issues).toEqual([
      expect.objectContaining({ code: "invalid-metadata-root" }),
    ]);
  });

  it("reports unavailable boundaries for native and malformed PE files", () => {
    const nativeBytes = buildNativePeFixture();
    const native = inspectManagedNativeBoundariesBytes(
      nativeBytes,
      managedPeFixtureTarget(nativeBytes),
    );
    expect(native).toMatchObject({
      metadata: { status: "absent" },
      pinvoke_imports: [],
      coverage: { state: "unavailable", issues: [] },
    });

    const malformedBytes = buildManagedPeFixture({
      corruptMetadataSignature: true,
      readyToRun: true,
    });
    const malformed = inspectManagedNativeBoundariesBytes(
      malformedBytes,
      managedPeFixtureTarget(malformedBytes),
    );
    expect(malformed).toMatchObject({
      metadata: { status: "malformed" },
      cli_native: {
        il_only: true,
        ready_to_run_signature: true,
        managed_native_header_rva: 0x2700,
        managed_native_header_size: 4,
      },
      summary: { ready_to_run: true, mixed_mode_or_native_header: true },
      coverage: {
        state: "unavailable",
        issues: [expect.objectContaining({ code: "invalid-metadata-root" })],
      },
    });
    expect(malformed.limitations).not.toContainEqual(
      expect.stringContaining("CLI header was not admitted"),
    );
  });

  it("reports unknown CLI header facts when the CLI header is unreadable", () => {
    const bytes = buildManagedPeFixture();
    bytes.writeUInt32LE(0x7fff_0000, 0x84 + 20 + 96 + 14 * 8);
    const result = inspectManagedNativeBoundariesBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    expect(result).toMatchObject({
      metadata: { status: "malformed" },
      cli_native: null,
      summary: { ready_to_run: null, mixed_mode_or_native_header: null },
      coverage: { state: "unavailable", issues: [expect.anything()] },
    });
  });
});

describe("independent managed metadata facets", () => {
  it("preserves identity, members, and imports when embedded resources are malformed", () => {
    const bytes = buildManagedPeFixture({ pinvoke: {}, readyToRun: true });
    bytes.writeUInt32LE(0x7fff_0000, 0x0200 + 24);
    const target = managedPeFixtureTarget(bytes);
    const artifact = inspectManagedArtifactBytes(bytes, target);
    const members = inspectManagedMembersBytes(bytes, target);
    const native = inspectManagedNativeBoundariesBytes(bytes, target);

    for (const result of [artifact, members, native]) {
      expect(result.module?.mvid).toBeTruthy();
      expect(result.metadata.status).toBe("partial");
      expect(result.coverage).toMatchObject({
        state: "partial",
        issues: expect.arrayContaining([
          expect.objectContaining({
            scope: "cli.resources",
            code: "invalid-directory",
          }),
        ]),
      });
    }
    expect(members.methods[0]?.name).toBe("Main");
    expect(native.pinvoke_imports[0]?.import_name).toBe("MessageBoxW");
    expect(native.cli_native?.ready_to_run_signature).toBe(true);
  });

  it("preserves native declarations when a module name cannot be decoded", () => {
    const bytes = buildManagedPeFixture({ pinvoke: {} });
    const original = inspectManagedNativeBoundariesBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    const row = original.module_refs[0]?.row_offset;
    if (row === undefined) throw new Error("Fixture must contain a ModuleRef");
    bytes.writeUInt16LE(0xffff, row);
    const result = inspectManagedNativeBoundariesBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.module_refs).toEqual([]);
    expect(result.pinvoke_imports).toMatchObject([
      {
        import_name: "MessageBoxW",
        import_scope_token: "0x1a000001",
        import_scope_name: null,
      },
    ]);
    expect(result.native_implementations[0]?.name).toBe("Main");
    expect(result.coverage).toMatchObject({
      state: "partial",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "invalid-heap-index" }),
      ]),
    });
  });
});

describe("managed PE fixture layout", () => {
  it("keeps ReadyToRun metadata separate from expanded metadata and resources", () => {
    const resourceData = Buffer.alloc(64 * 1024, 0x5a);
    const bytes = buildManagedPeFixture({
      readyToRun: true,
      references: Array.from(
        { length: 2_200 },
        (_, index) => `Reference.${String(index).padStart(4, "0")}`,
      ),
      resourceData,
    });
    const target = managedPeFixtureTarget(bytes);
    const artifact = inspectManagedArtifactBytes(bytes, target);
    const boundaries = inspectManagedNativeBoundariesBytes(bytes, target);

    expect(artifact.coverage).toMatchObject({ state: "complete", issues: [] });
    expect(artifact.references).toHaveLength(2_200);
    expect(artifact.resources[0]).toMatchObject({
      data_length: resourceData.length,
      data_sha256: createHash("sha256").update(resourceData).digest("hex"),
    });
    expect(boundaries.cli_native).toMatchObject({
      ready_to_run_signature: true,
      managed_native_header_size: 4,
    });
    expect(boundaries.cli_native?.managed_native_header_rva).toBeGreaterThan(
      0x2700,
    );
  });
});
