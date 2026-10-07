import { describe, expect, it } from "vitest";

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
    expect(result.limitations).toContain(
      "P/Invoke rows prove managed import declarations only; this inspection does not verify that a native library, export, thunk, or provider-qualified function exists.",
    );
  });

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

  it("marks CLI header facets as defaults when the CLI header is unreadable", () => {
    const bytes = buildManagedPeFixture();
    bytes.writeUInt32LE(0x7fff_0000, 0x84 + 20 + 96 + 14 * 8);
    const result = inspectManagedNativeBoundariesBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    expect(result).toMatchObject({
      metadata: { status: "malformed" },
      cli_native: { il_only: false },
      coverage: { state: "unavailable", issues: [expect.anything()] },
    });
    expect(result.limitations).toContainEqual(
      expect.stringContaining("CLI header was not admitted"),
    );
  });
});
