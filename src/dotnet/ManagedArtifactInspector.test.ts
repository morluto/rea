import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "./ManagedNativeBoundaryInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";
import { readManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import { readManagedPeLayout } from "./ManagedPeReader.js";

const metadataLayoutFor = (bytes: Buffer) => {
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("fixture omitted CLI metadata");
  return readManagedMetadataLayout(
    bytes,
    pe.rvaToOffset(pe.cli.metadata.rva, pe.cli.metadata.size, "cli.metadata"),
    pe.cli.metadata.size,
  );
};

const resizedOptionalHeader = (
  size: number,
  magic: number,
): { readonly bytes: Buffer; readonly optional: number } => {
  const bytes = buildManagedPeFixture();
  const coff = bytes.readUInt32LE(0x3c) + 4;
  const optional = coff + 20;
  const originalSize = bytes.readUInt16LE(coff + 16);
  const section = Buffer.from(
    bytes.subarray(optional + originalSize, optional + originalSize + 40),
  );
  section.copy(bytes, optional + size);
  bytes.writeUInt16LE(size, coff + 16);
  bytes.writeUInt16LE(magic, optional);
  return { bytes, optional };
};

describe("managed PE optional-header directory count", () => {
  it.each([96, 108, 111])(
    "retains an unreadable PE32+ directory count at optional size %i",
    (optionalSize) => {
      const { bytes, optional } = resizedOptionalHeader(optionalSize, 0x020b);
      // The section's first four bytes look like a count that excludes CLI.
      bytes.writeUInt32LE(14, optional + optionalSize);

      const layout = readManagedPeLayout(bytes);
      expect(layout).toMatchObject({
        optionalHeader: "pe32-plus",
        machine: 0x014c,
        cli: null,
        cliDirectoryState: "unreadable",
        cliIssue: {
          code: "invalid-directory",
          scope: "pe.optional-header",
        },
      });
      const result = inspectManagedArtifactBytes(
        bytes,
        managedPeFixtureTarget(bytes),
      );
      expect(result.classification.status).toBe("malformed");
      expect(result.metadata.status).toBe("malformed");
      expect(result.coverage.issues).toContainEqual(
        expect.objectContaining({
          code: "invalid-directory",
          scope: "pe.optional-header",
        }),
      );
    },
  );

  it.each([
    { size: 96, magic: 0x010b, countOffset: 92, header: "pe32" },
    { size: 112, magic: 0x020b, countOffset: 108, header: "pe32-plus" },
  ])("accepts a minimum $header header with no CLI directory", (fixture) => {
    const { bytes, optional } = resizedOptionalHeader(
      fixture.size,
      fixture.magic,
    );
    bytes.writeUInt32LE(0, optional + fixture.countOffset);

    expect(readManagedPeLayout(bytes)).toMatchObject({
      optionalHeader: fixture.header,
      cli: null,
      cliDirectoryState: "absent",
      cliIssue: null,
    });
  });
});

describe("managed CLI directory availability", () => {
  it("keeps a declared but truncated CLI directory malformed", () => {
    const bytes = buildManagedPeFixture();
    const peOffset = bytes.readUInt32LE(0x3c);
    const coff = peOffset + 4;
    const optional = coff + 20;
    const originalOptionalSize = bytes.readUInt16LE(coff + 16);
    const truncatedOptionalSize = 96 + 14 * 8 + 7;
    const sectionHeader = Buffer.from(
      bytes.subarray(
        optional + originalOptionalSize,
        optional + originalOptionalSize + 40,
      ),
    );
    sectionHeader.copy(bytes, optional + truncatedOptionalSize);
    bytes.writeUInt16LE(truncatedOptionalSize, coff + 16);
    bytes.writeUInt32LE(15, optional + 92);

    const layout = readManagedPeLayout(bytes);
    expect(layout).toMatchObject({
      cli: null,
      cliDirectoryState: "unreadable",
      cliIssue: {
        code: "invalid-directory",
        scope: "pe.data-directories",
      },
    });

    const target = managedPeFixtureTarget(bytes);
    const results = [
      inspectManagedArtifactBytes(bytes, target),
      inspectManagedMembersBytes(bytes, target),
      inspectManagedNativeBoundariesBytes(bytes, target),
    ];
    for (const [index, result] of results.entries()) {
      expect(result.metadata.status).toBe("malformed");
      expect(result.coverage).toMatchObject({
        state: index === 0 ? "partial" : "unavailable",
        issues: [
          expect.objectContaining({
            code: "invalid-directory",
            scope: "pe.data-directories",
          }),
        ],
      });
    }
  });

  it("treats a CLI directory excluded by NumberOfRvaAndSizes as absent", () => {
    const bytes = buildManagedPeFixture();
    const peOffset = bytes.readUInt32LE(0x3c);
    const optional = peOffset + 4 + 20;
    bytes.writeUInt32LE(14, optional + 92);

    const layout = readManagedPeLayout(bytes);
    expect(layout).toMatchObject({
      cli: null,
      cliDirectoryState: "absent",
      cliIssue: null,
    });
    const result = inspectManagedArtifactBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    expect(result.classification.status).toBe("not-managed");
    expect(result.metadata.status).toBe("absent");
  });

  it("retains an in-range CLI directory when the count overstates later entries", () => {
    const bytes = buildManagedPeFixture();
    const peOffset = bytes.readUInt32LE(0x3c);
    const optional = peOffset + 4 + 20;
    bytes.writeUInt32LE(17, optional + 92);

    const layout = readManagedPeLayout(bytes);
    expect(layout.cliDirectoryState).toBe("present");
    expect(layout.cliIssue).toBeNull();
    expect(layout.cli).not.toBeNull();
    const result = inspectManagedArtifactBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    expect(result.classification.status).toBe("managed");
    expect(result.metadata.status).toBe("complete");
  });
});

describe("managed artifact inventory", () => {
  it.each([
    { moduleRowCount: 0, assemblyRowCount: 1, scope: "metadata.Module" },
    { moduleRowCount: 2, assemblyRowCount: 1, scope: "metadata.Module" },
    { moduleRowCount: 1, assemblyRowCount: 2, scope: "metadata.Assembly" },
  ])("marks invalid identity table cardinality partial: %j", (options) => {
    const bytes = buildManagedPeFixture(options);
    const target = managedPeFixtureTarget(bytes);
    const results = [
      inspectManagedArtifactBytes(bytes, target),
      inspectManagedMembersBytes(bytes, target),
      inspectManagedNativeBoundariesBytes(bytes, target),
    ];

    for (const result of results) {
      expect(result.metadata.status).toBe("partial");
      expect(result.coverage).toMatchObject({
        state: "partial",
        issues: [
          expect.objectContaining({
            code: "invalid-row",
            scope: options.scope,
          }),
        ],
      });
    }
    if (options.moduleRowCount === 0) expect(results[0]?.module).toBeNull();
    else expect(results[0]?.module?.name).toBe("Fixture.dll");
  });

  it.each([
    { moduleRowCount: 1, assemblyRowCount: 0, targetFramework: null },
    { moduleRowCount: 1, assemblyRowCount: 1 },
  ])("keeps valid identity table cardinalities complete: %j", (options) => {
    const bytes = buildManagedPeFixture(options);
    const result = inspectManagedArtifactBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.metadata.status).toBe("complete");
    expect(result.coverage).toMatchObject({ state: "complete", issues: [] });
    expect(result.assembly?.name ?? null).toBe(
      options.assemblyRowCount === 0 ? null : "Fixture.Managed",
    );
  });

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
});

describe("managed artifact coded indexes", () => {
  it("reports an invalid ManifestResource implementation while retaining the resource", () => {
    const bytes = buildManagedPeFixture({ resourceImplementationRaw: 9 });
    const target = managedPeFixtureTarget(bytes);
    const result = inspectManagedArtifactBytes(bytes, target);
    const boundaries = inspectManagedNativeBoundariesBytes(bytes, target);

    expect(result.resources).toMatchObject([
      {
        name: "Fixture.resources",
        implementation_token: null,
        embedded: false,
      },
    ]);
    expect(result.coverage).toMatchObject({
      state: "partial",
      issues: [
        expect.objectContaining({
          code: "invalid-row",
          scope: "metadata.ManifestResource:0x28000001",
          detail: expect.stringContaining(
            "coded index 0x9 is invalid: coded index selects row 2 in table 35, which has 1 rows",
          ),
        }),
      ],
    });
    const layout = metadataLayoutFor(bytes);
    expect(result.coverage.issues[0]?.offset).toBe(
      (result.resources[0]?.row_offset ?? 0) + 8 + layout.stringIndexSize,
    );
    expect(boundaries.coverage).toMatchObject({
      state: "partial",
      issues: [
        expect.objectContaining({
          scope: "metadata.ManifestResource:0x28000001",
        }),
      ],
    });
  });

  it.each([
    [
      0,
      "CustomAttribute constructor coded index 0x0 is null, but Type must reference a MethodDef or MemberRef row",
    ],
    [
      19,
      "coded index 0x13 is invalid: coded index selects row 2 in table 10, which has 1 rows",
    ],
  ] as const)(
    "preserves readable attribute facts for constructor index %s",
    (rawType, detail) => {
      const bytes = buildManagedPeFixture({ customAttributeTypeRaw: rawType });
      const result = inspectManagedArtifactBytes(
        bytes,
        managedPeFixtureTarget(bytes),
      );
      const text = Buffer.from(".NETCoreApp,Version=v8.0", "utf8");
      const attributeValue = Buffer.concat([
        Buffer.from([1, 0, text.length]),
        text,
        Buffer.alloc(2),
      ]);

      expect(result.attributes).toMatchObject([
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
      ]);
      expect(result.coverage).toMatchObject({
        state: "partial",
        issues: [
          expect.objectContaining({
            code: "invalid-row",
            scope: "metadata.CustomAttribute:0x0c000001",
            detail: expect.stringContaining(detail),
          }),
        ],
      });
    },
  );

  it("reports coded-index column offsets after widened string and coded-index columns", () => {
    const references = Array.from(
      { length: 2_500 },
      (_, index) => `Reference.${"r".repeat(24)}.${String(index)}`,
    );
    const bytes = buildManagedPeFixture({
      references,
      extendsRaw: 9,
      customAttributeTypeRaw: 0,
    });
    const layout = metadataLayoutFor(bytes);
    const artifact = inspectManagedArtifactBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    const members = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    const extendsIssue = members.coverage.issues.find((issue) =>
      issue.scope.startsWith("metadata.TypeDef:"),
    );
    const attributeIssue = artifact.coverage.issues.find((issue) =>
      issue.scope.startsWith("metadata.CustomAttribute:"),
    );
    const typeDef = members.types[0];
    const attributeTable = layout.table(12);

    expect(layout.stringIndexSize).toBe(4);
    expect(layout.codedIndexSize("HasCustomAttribute")).toBe(4);
    expect(typeDef).toBeDefined();
    expect(extendsIssue?.offset).toBe(
      (typeDef?.row_offset ?? 0) + 4 + 2 * layout.stringIndexSize,
    );
    expect(attributeTable).toBeDefined();
    expect(attributeIssue?.offset).toBe(
      (attributeTable?.offset ?? 0) +
        layout.codedIndexSize("HasCustomAttribute"),
    );
  });

  it("resolves local attribute constructors without rescanning TypeDef rows", () => {
    // The owning type follows every empty type. A per-attribute TypeDef scan
    // took about 38 s here; the owner index is built once per layout.
    const bytes = buildManagedPeFixture({
      additionalEmptyTypes: 16_000,
      customAttributeRowCount: 16_000,
      customAttributeTypeRaw: (1 << 3) | 2,
      typeName: "LookupAttribute",
      extendsRaw: 0,
      methodName: ".ctor",
      methodFlags: 0x1886,
      methodSignature: Buffer.from([0x20, 0x01, 0x01, 0x0e]),
    });
    const start = performance.now();
    const artifact = inspectManagedArtifactBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(performance.now() - start).toBeLessThan(2000);
    expect(artifact.coverage).toEqual({ state: "complete", issues: [] });
    expect(artifact.attributes).toHaveLength(16_000);
    expect(
      artifact.attributes.every(
        (attribute) => attribute.type_name === "Fixture.LookupAttribute",
      ),
    ).toBe(true);
  }, 30_000);
});

describe("managed artifact reference inventory", () => {
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

  it("preserves duplicate AssemblyRef rows in metadata order", () => {
    const bytes = buildManagedPeFixture({
      references: [
        "UnityEngine.CoreModule",
        "UnityEngine.CoreModule",
        "System.Runtime",
      ],
    });
    const result = inspectManagedArtifactBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.references.map(({ name }) => name)).toEqual([
      "UnityEngine.CoreModule",
      "UnityEngine.CoreModule",
      "System.Runtime",
    ]);
    expect(result.classification.runtime_family).toBe("unity-mono");
  });
});

describe("managed fixture data layout", () => {
  it("keeps ReadyToRun metadata and resources intact with large metadata", () => {
    const resource = Buffer.alloc(2_048, 0x52);
    const fieldSignature = Buffer.concat([
      Buffer.from([0x06]),
      Buffer.alloc(8_000, 0x0f),
      Buffer.from([0x08]),
    ]);
    const bytes = buildManagedPeFixture({
      fieldSignature,
      readyToRun: true,
      resourceData: resource,
    });
    const result = inspectManagedArtifactBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.classification).toMatchObject({
      status: "managed",
      implementation: "cil-and-ready-to-run",
    });
    expect(result.resources[0]).toMatchObject({
      embedded: true,
      data_length: resource.length,
      data_sha256: createHash("sha256").update(resource).digest("hex"),
    });
    expect(result.coverage).toMatchObject({ state: "complete", issues: [] });
  });
});

describe("managed artifact metadata identity", () => {
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

it("derives the string heap width after expanded AssemblyRef names", () => {
  const references = Array.from(
    { length: 5_000 },
    (_, index) => `Reference.${String(index).padStart(4, "0")}`,
  );
  const bytes = buildManagedPeFixture({ references });
  const result = inspectManagedArtifactBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );

  expect(result.references).toHaveLength(references.length);
  expect(result.references.at(-1)?.name).toBe("Reference.4999");
  expect(result.coverage).toMatchObject({ state: "complete", issues: [] });

  const malformedBytes = buildManagedPeFixture({
    references,
    malformedAssemblyReferenceRows: [5_000],
  });
  const malformedResult = inspectManagedArtifactBytes(
    malformedBytes,
    managedPeFixtureTarget(malformedBytes),
  );
  expect(malformedResult.references).toHaveLength(4_999);
  expect(malformedResult.coverage).toMatchObject({
    state: "partial",
    issues: [expect.objectContaining({ code: "invalid-heap-index" })],
  });
});

it("derives ResolutionScope and Implementation widths at 16,384 AssemblyRefs", () => {
  const references = Array.from(
    { length: 16_384 },
    (_, index) => `Reference.${String(index).padStart(5, "0")}`,
  );
  const bytes = buildManagedPeFixture({ references });
  const result = inspectManagedArtifactBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );

  expect(result.references).toHaveLength(references.length);
  expect(result.references.at(-1)?.name).toBe("Reference.16383");
  expect(result.resources).toMatchObject([
    { name: "Fixture.resources", embedded: true, data_length: 13 },
  ]);
  expect(result.coverage).toMatchObject({ state: "complete", issues: [] });
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
