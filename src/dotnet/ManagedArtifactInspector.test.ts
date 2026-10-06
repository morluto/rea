import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "./ManagedNativeBoundaryInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

describe("managed artifact inventory", () => {
  it("statically inspects PE files with more than 96 sections", () => {
    const fixture = buildManagedPeFixture();
    const peOffset = fixture.readUInt32LE(0x3c);
    const coffOffset = peOffset + 4;
    const optionalHeaderSize = fixture.readUInt16LE(coffOffset + 16);
    const sectionOffset = coffOffset + 20 + optionalHeaderSize;
    const sectionDataOffset = 0x1200;
    const bytes = Buffer.alloc(sectionDataOffset + 0x0e00);
    fixture.copy(bytes, 0, 0, 0x0200);
    fixture.copy(bytes, sectionDataOffset, 0x0200, 0x1000);
    bytes.writeUInt16LE(97, coffOffset + 2);
    bytes.writeUInt32LE(sectionDataOffset, sectionOffset + 20);

    const result = inspectManagedArtifactBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.classification.status).toBe("managed");
    expect(result.pe.section_count).toBe(97);
    expect(sectionOffset + 97 * 40).toBeLessThanOrEqual(sectionDataOffset);
  });

  it("inventories module, assembly, framework, references, and resources without loading CLR code", () => {
    const resource = Buffer.from("source-owned resource");
    const bytes = buildManagedPeFixture({ resourceData: resource });
    const result = inspectManagedArtifactBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

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
    expect(result.references).toEqual([
      expect.objectContaining({ name: "System.Runtime" }),
    ]);
    expect(result.resources).toEqual([
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

  it("returns all references inline while classifying from the full inventory", () => {
    const bytes = buildManagedPeFixture({
      references: ["System.Runtime", "UnityEngine.CoreModule"],
    });
    const result = inspectManagedArtifactBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.classification.runtime_family).toBe("unity-mono");
    expect(result.references).toHaveLength(2);
    expect(result.coverage.state).toBe("complete");
    expect(result.coverage.issues).toEqual([]);
  });

  it("accepts CLI metadata GUIDs without RFC UUID version or variant bits", () => {
    const bytes = buildManagedPeFixture({
      mvid: Buffer.from("3aebc60edc4a544b1f458b4ed40b33b1", "hex"),
    });
    const result = inspectManagedArtifactBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    const members = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    const boundaries = inspectManagedNativeBoundariesBytes(
      bytes,
      managedPeFixtureTarget(bytes),
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
      managedPeFixtureTarget(bytes),
    );

    expect(result.fields[0]?.signature).toMatchObject({
      parse_status: "decoded",
      field_type: "i4**[]",
    });
    expect(result.methods[0]?.signature).toMatchObject({
      parse_status: "decoded",
      return_type: "i4&",
      parameter_types: ["i4*", "string&"],
    });
  });
});

it("preserves U+FEFF in references and fixed attribute strings", () => {
  const bytes = buildManagedPeFixture({
    references: ["\uFEFFSystem.Runtime", "System.\uFEFFRuntime"],
    targetFramework: "\uFEFF.NETCoreApp,Version=v8.0",
  });
  const result = inspectManagedArtifactBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );
  expect(result.references.map((reference) => reference.name)).toEqual([
    "\uFEFFSystem.Runtime",
    "System.\uFEFFRuntime",
  ]);
  expect(result.target_frameworks).toEqual(["\uFEFF.NETCoreApp,Version=v8.0"]);
});
