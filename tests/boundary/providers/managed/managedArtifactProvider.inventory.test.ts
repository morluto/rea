import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { BinaryTarget } from "../../../../src/domain/binaryTarget.js";
import { inspectManagedArtifactBytes } from "../../../../src/dotnet/ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "../../../../src/dotnet/ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "../../../../src/dotnet/ManagedNativeBoundaryInspector.js";
import { buildManagedPeFixture } from "../../../fixtures/managedPe.js";

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

describe("managed artifact inventory", () => {
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

  it("accepts CLI metadata GUIDs without RFC UUID version or variant bits", () => {
    const bytes = buildManagedPeFixture({
      mvid: Buffer.from("3aebc60edc4a544b1f458b4ed40b33b1", "hex"),
    });
    const result = inspectManagedArtifactBytes(bytes, target(bytes), limits);
    const members = inspectManagedMembersBytes(
      bytes,
      target(bytes),
      memberLimits,
    );
    const boundaries = inspectManagedNativeBoundariesBytes(
      bytes,
      target(bytes),
      nativeBoundaryLimits,
    );

    expect(result.module?.mvid).toBe("0ec6eb3a-4adc-4b54-1f45-8b4ed40b33b1");
    expect(result.classification.status).toBe("managed");
    expect(members.identity_scope.requires_mvid).toBe(result.module?.mvid);
    expect(boundaries.identity_scope.requires_mvid).toBe(result.module?.mvid);
  });

  it("decodes ECMA-335 pointer and byref element types without swapping them", () => {
    const bytes = buildManagedPeFixture({
      fieldSignature: Buffer.from([0x06, 0x1d, 0x0f, 0x0f, 0x08]),
      methodSignature: Buffer.from([
        0x00, 0x02, 0x10, 0x08, 0x0f, 0x08, 0x10, 0x0e,
      ]),
    });
    const result = inspectManagedMembersBytes(
      bytes,
      target(bytes),
      memberLimits,
    );

    expect(result.fields.items[0]?.signature).toMatchObject({
      parse_status: "decoded",
      field_type: "i4**[]",
    });
    expect(result.methods.items[0]?.signature).toMatchObject({
      parse_status: "decoded",
      return_type: "i4&",
      parameter_types: ["i4*", "string&"],
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
  executableRole: "application",
  managed: true,
});
