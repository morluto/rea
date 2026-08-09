import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { BinaryTarget } from "../../../../src/domain/binaryTarget.js";
import { inspectManagedMembersBytes } from "../../../../src/dotnet/ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "../../../../src/dotnet/ManagedNativeBoundaryInspector.js";
import {
  buildManagedPeFixture,
  buildNativePeFixture,
} from "../../../fixtures/managedPe.js";

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
});
const target = (bytes: Buffer): BinaryTarget => ({
  path: "/fixture.exe",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  kind: "executable",
  format: "pe",
  architecture: "x86",
  availableArchitectures: ["x86"],
  executableRole: "application",
  managed: true,
});
