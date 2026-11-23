import { describe, expect, it } from "vitest";

import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { readManagedMetadataLayout } from "../domain/managed/managedMetadataLayout.js";
import { readManagedPeLayout } from "../domain/managed/managedPeReader.js";
import {
  buildManagedMemberPointerFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

const metadataLayout = (bytes: Buffer) => {
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("Fixture omitted CLI metadata");
  return readManagedMetadataLayout(
    bytes,
    pe.rvaToOffset(pe.cli.metadata.rva, pe.cli.metadata.size, "cli.metadata"),
    pe.cli.metadata.size,
  );
};

describe("managed member pointer ownership", () => {
  it.each([
    {
      label: "identity pointer tables",
      fieldPointers: [1, 2],
      methodPointers: [1, 2],
      streamName: "#-" as const,
    },
    {
      label: "empty pointer tables with direct lists",
      fieldPointers: [],
      methodPointers: [],
      streamName: "#-" as const,
    },
  ])("preserves $label", ({ fieldPointers, methodPointers, streamName }) => {
    const bytes = buildManagedMemberPointerFixture({
      fieldPointers,
      methodPointers,
      streamName,
    });
    const target = managedPeFixtureTarget(bytes);
    const members = inspectManagedMembersBytes(bytes, target);
    const artifact = inspectManagedArtifactBytes(bytes, target);

    expect(members.coverage).toEqual({ state: "complete", issues: [] });
    expect(members.fields.map((field) => field.declaring_type)).toEqual([
      "Fixture.A",
      "Fixture.B",
    ]);
    expect(members.methods.map((method) => method.declaring_type)).toEqual([
      "Fixture.A",
      "Fixture.B",
    ]);
    expect(artifact.attributes[0]?.type_name).toBe("Fixture.A");
  });
});

describe("invalid managed member pointers", () => {
  describe.each([
    {
      table: "fields" as const,
      pointers: "fieldPointers" as const,
      scope: "metadata.FieldPtr",
      prefix: "0x040000",
      names: ["firstField", "secondField"],
      independent: "methods" as const,
    },
    {
      table: "methods" as const,
      pointers: "methodPointers" as const,
      scope: "metadata.MethodPtr",
      prefix: "0x060000",
      names: [".ctor", ".ctor"],
      independent: "fields" as const,
    },
  ])(
    "invalid $table pointers",
    ({ table, pointers, scope, prefix, names, independent }) => {
      it.each([
        { label: "zero row", rows: [0, 1], owners: [null, null] },
        { label: "out-of-range row", rows: [3, 1], owners: [null, null] },
        { label: "duplicate row", rows: [1, 1], owners: [null, null] },
        { label: "omitted row", rows: [1], owners: ["Fixture.A", null] },
      ])(
        "preserves member facts and independent ownership for $label",
        ({ rows, owners }) => {
          const bytes = buildManagedMemberPointerFixture({ [pointers]: rows });
          const layout = metadataLayout(bytes);
          const pointerTable = layout.table(table === "fields" ? 3 : 5);
          if (pointerTable === undefined)
            throw new Error("Fixture omitted pointer table");
          const diagnosticOffset =
            pointerTable.offset +
            (rows[0] === rows[1] ? pointerTable.rowSize : 0);
          const result = inspectManagedMembersBytes(
            bytes,
            managedPeFixtureTarget(bytes),
          );

          expect(result.coverage.state).toBe("partial");
          expect(result.coverage.issues).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                code: "invalid-row",
                scope,
                offset: diagnosticOffset,
              }),
            ]),
          );
          expect(
            result[table].map(
              ({ token, name, declaring_type, declaring_type_token }) => ({
                token,
                name,
                declaring_type,
                declaring_type_token,
              }),
            ),
          ).toEqual(
            owners.map((owner, index) => ({
              token: `${prefix}0${index + 1}`,
              name: names[index],
              declaring_type: owner,
              declaring_type_token: owner === null ? null : "0x02000002",
            })),
          );
          expect(
            result[independent].map((member) => member.declaring_type),
          ).toEqual(["Fixture.B", "Fixture.A"]);
          expect(
            result.coverage.issues.some(
              (issue) =>
                issue.scope ===
                (table === "fields"
                  ? "metadata.MethodPtr"
                  : "metadata.FieldPtr"),
            ),
          ).toBe(false);
        },
      );
    },
  );
});

describe("managed constructor ownership and pointer stream extent", () => {
  it.each([
    { label: "malformed table", methodPointers: [2, 0] },
    { label: "omitted constructor row", methodPointers: [2] },
  ])(
    "preserves attribute facts with an unknown constructor owner for $label",
    ({ methodPointers }) => {
      const bytes = buildManagedMemberPointerFixture({ methodPointers });
      const result = inspectManagedArtifactBytes(
        bytes,
        managedPeFixtureTarget(bytes),
      );

      expect(result.coverage).toMatchObject({
        state: "partial",
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "invalid-row",
            scope: "metadata.MethodPtr",
          }),
        ]),
      });
      expect(result.attributes).toMatchObject([
        {
          token: "0x0c000001",
          parent_token: "0x20000001",
          constructor_token: "0x06000001",
          type_name: null,
          value_length: 12,
          value_sha256:
            "ef46e4e6444ea51d2479d5870ab66cc91e5030b036261b008b2beb1c346524c0",
        },
      ]);
    },
  );

  it.each([
    { name: "FieldPtr", table: 3 },
    { name: "MethodPtr", table: 5 },
  ])("rejects a table stream ending inside a $name row", ({ table }) => {
    const bytes = buildManagedMemberPointerFixture();
    const layout = metadataLayout(bytes);
    const pointers = layout.table(table);
    if (pointers === undefined)
      throw new Error("Fixture omitted pointer table");
    const versionLength = bytes.readUInt32LE(layout.rootOffset + 12);
    const firstStreamHeader =
      ((layout.rootOffset + 16 + versionLength + 3) & ~3) + 4;
    const streamNameEnd = bytes.indexOf(0, firstStreamHeader + 8);
    expect(bytes.toString("ascii", firstStreamHeader + 8, streamNameEnd)).toBe(
      "#-",
    );
    const tablesOffset =
      layout.rootOffset + bytes.readUInt32LE(firstStreamHeader);
    bytes.writeUInt32LE(
      pointers.offset + pointers.rowSize - 1 - tablesOffset,
      firstStreamHeader + 4,
    );

    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    expect(result.coverage).toMatchObject({
      state: "unavailable",
      issues: [
        expect.objectContaining({
          code: "invalid-metadata-root",
          scope: "metadata.table-data",
        }),
      ],
    });
    expect(result.fields).toEqual([]);
    expect(result.methods).toEqual([]);
  });
});
