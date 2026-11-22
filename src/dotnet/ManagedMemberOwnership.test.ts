import { fc, it } from "@fast-check/vitest";
import { describe, expect, vi } from "vitest";

import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { managedDecodeBudget } from "../domain/managed/managedDecodeBudget.js";
import * as ownershipProducer from "../domain/managed/managedMemberOwnership.js";
import { memberListIndexSize } from "../domain/managed/managedMemberPointers.js";
import { readTypeMemberListFacts } from "../domain/managed/managedTypeMemberLists.js";
import {
  metadataRowOffset,
  readManagedMetadataLayout,
} from "../domain/managed/managedMetadataLayout.js";
import { buildManagedMemberSelectionCapacityFixture } from "../../tests/fixtures/managedMemberCapacity.js";

const { memberDeclaringTypeRowLookup } = ownershipProducer;
import {
  buildManagedMemberPointerFixture,
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";
import { readManagedPeLayout } from "../domain/managed/managedPeReader.js";
import { ManagedReaderFailure } from "../domain/managed/managedReaderFailure.js";

const metadataLayout = (bytes: Buffer) => {
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("Fixture omitted CLI metadata");
  return readManagedMetadataLayout(
    bytes,
    pe.rvaToOffset(pe.cli.metadata.rva, pe.cli.metadata.size, "cli.metadata"),
    pe.cli.metadata.size,
  );
};

describe("managed declaring type ownership", () => {
  it.prop([
    fc.tuple(
      fc
        .array(fc.integer({ min: 1, max: 3 }), { minLength: 3, maxLength: 3 })
        .map((starts) => starts.sort((left, right) => left - right)),
      fc
        .array(fc.integer({ min: 1, max: 3 }), { minLength: 3, maxLength: 3 })
        .map((starts) => starts.sort((left, right) => left - right)),
    ),
  ])(
    "matches literal ownership ranges for valid nondecreasing list starts",
    ([fields, methods]) => {
      const bytes = buildManagedMemberPointerFixture();
      const layout = metadataLayout(bytes);
      const types = layout.table(2);
      if (types === undefined) throw new Error("Fixture omitted TypeDef");
      for (let row = 0; row < 3; row++) {
        const fieldOffset =
          types.offset +
          row * types.rowSize +
          4 +
          2 * layout.stringIndexSize +
          layout.codedIndexSize("TypeDefOrRef");
        bytes.writeUInt16LE(fields[row] ?? 0, fieldOffset);
        bytes.writeUInt16LE(
          methods[row] ?? 0,
          fieldOffset + memberListIndexSize(layout, 4),
        );
      }
      const target = managedPeFixtureTarget(bytes);
      const members = inspectManagedMembersBytes(bytes, target);
      const artifact = inspectManagedArtifactBytes(bytes, target);
      for (const [table, starts] of [
        ["fields", fields],
        ["methods", methods],
      ] as const) {
        // The fixture's pointers reorder physical rows 1,2 to list positions 2,1.
        const expected = [2, 1].map((position) => {
          let owner: number | null = null;
          for (let index = 0; index < starts.length; index += 1) {
            const start = starts[index];
            const end = starts[index + 1] ?? 3;
            if (start !== undefined && position >= start && position < end) {
              owner = index;
              break;
            }
          }
          return owner === null ? null : members.types[owner]?.full_name;
        });
        expect(members[table].map((member) => member.declaring_type)).toEqual(
          expected,
        );
      }
      expect(artifact.attributes[0]?.type_name).toBe(
        members.methods[0]?.declaring_type,
      );
    },
  );

  it("indexes wide valid member lists once per layout", () => {
    const count = 65_538;
    const bytes = buildManagedPeFixture({
      additionalEmptyTypes: count - 3,
      methodRowCount: count,
    });
    const layout = metadataLayout(bytes);
    const types = layout.table(2);
    if (types === undefined) throw new Error("Fixture omitted TypeDef");
    const methodOffset =
      types.offset +
      4 +
      2 * layout.stringIndexSize +
      layout.codedIndexSize("TypeDefOrRef") +
      memberListIndexSize(layout, 4);
    // Each preceding TypeDef owns one row; later TypeDefs have empty intervals.
    // This exercises the four-byte list-index boundary without malformed starts.
    for (let row = 0; row < count; row += 1)
      bytes.writeUInt32LE(
        Math.min(row + 1, 65_537),
        methodOffset + row * types.rowSize,
      );
    const facts = readTypeMemberListFacts(bytes, layout);
    const lookup = memberDeclaringTypeRowLookup(bytes, layout, 6, facts);
    expect(lookup(65_536)).toBe(65_536);
    expect(lookup(65_535)).toBe(65_535);
    expect(memberDeclaringTypeRowLookup(bytes, layout, 6, facts)).toBe(lookup);
    expect([lookup(0), lookup(count + 1)]).toEqual([0, 0]);
  });

  it("admits ownership storage before allocation and retains failed admission", () => {
    const bytes = buildManagedPeFixture();
    const layout = metadataLayout(bytes);
    const facts = readTypeMemberListFacts(bytes, layout);
    const budget = managedDecodeBudget(layout);
    const capacityFailure = new ManagedReaderFailure({
      code: "resource-limit",
      scope: "metadata.representation",
      offset: layout.table(2)?.offset ?? null,
      detail: "No remaining ownership index capacity",
    });
    const admission = vi.spyOn(budget, "reserve").mockImplementation(() => {
      throw capacityFailure;
    });
    let allocations = 0;
    vi.stubGlobal(
      "Uint32Array",
      new Proxy(Uint32Array, {
        construct(target, args, newTarget) {
          allocations++;
          return Reflect.construct(target, args, newTarget);
        },
      }),
    );
    try {
      expect(() =>
        memberDeclaringTypeRowLookup(bytes, layout, 6, facts),
      ).toThrow(capacityFailure);
      expect(() =>
        memberDeclaringTypeRowLookup(bytes, layout, 6, facts),
      ).toThrow(capacityFailure);
      expect(admission).toHaveBeenCalledTimes(1);
      expect(allocations).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      admission.mockRestore();
    }
  });
});

describe("selected FieldList and MethodList interval iteration", () => {
  it("skips building full-table owner lookups when monotonic intervals apply", () => {
    const bytes = buildManagedMemberSelectionCapacityFixture(200);
    const target = managedPeFixtureTarget(bytes);
    const spy = vi.spyOn(ownershipProducer, "memberDeclaringTypeRowLookup");
    try {
      const selected = inspectManagedMembersBytes(bytes, target, {
        typeNames: ["Fixture.Empty0"],
      });
      expect(spy).not.toHaveBeenCalled();
      expect(selected.coverage).toEqual({ state: "complete", issues: [] });
      expect(selected.fields).toMatchObject([
        { name: "Field0", declaring_type: "Fixture.Empty0" },
      ]);
      expect(selected.methods).toMatchObject([
        { name: "Method0", declaring_type: "Fixture.Empty0" },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("falls back cleanly when FieldList or MethodList pointers decrease", () => {
    const bytes = buildManagedPeFixture({
      additionalEmptyTypes: 3,
      fieldRowCount: 3,
      methodRowCount: 3,
      distinctMemberNames: true,
    });
    const layout = metadataLayout(bytes);
    const fieldColOffset =
      4 + 2 * layout.stringIndexSize + layout.codedIndexSize("TypeDefOrRef");
    const methodColOffset = fieldColOffset + memberListIndexSize(layout, 4);
    const row2 = metadataRowOffset(layout, 2, 2);
    const row3 = metadataRowOffset(layout, 2, 3);
    const row4 = metadataRowOffset(layout, 2, 4);
    bytes.writeUInt16LE(2, row2 + fieldColOffset);
    bytes.writeUInt16LE(3, row3 + fieldColOffset);
    bytes.writeUInt16LE(2, row4 + fieldColOffset);
    bytes.writeUInt16LE(2, row2 + methodColOffset);
    bytes.writeUInt16LE(3, row3 + methodColOffset);
    bytes.writeUInt16LE(2, row4 + methodColOffset);

    const spy = vi.spyOn(ownershipProducer, "memberDeclaringTypeRowLookup");
    try {
      const result = inspectManagedMembersBytes(
        bytes,
        managedPeFixtureTarget(bytes),
        { typeNames: ["Fixture.Empty0", "Fixture.Empty1"] },
      );
      expect(spy).toHaveBeenCalled();
      expect(result.coverage.state).toBe("partial");
      expect(result.coverage.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "invalid-row",
            detail: expect.stringContaining("FieldList start 2 decreases"),
          }),
          expect.objectContaining({
            code: "invalid-row",
            detail: expect.stringContaining("MethodList start 2 decreases"),
          }),
        ]),
      );
      expect(result.fields.map(({ name }) => name)).toEqual(["Field0"]);
      expect(result.methods.map(({ name }) => name)).toEqual(["Method0"]);
    } finally {
      spy.mockRestore();
    }
  });
});
