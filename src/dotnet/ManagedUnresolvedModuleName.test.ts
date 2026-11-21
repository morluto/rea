import { expect, it } from "vitest";

import {
  managedStringsAmbiguity,
  STRING_AMBIGUITY_MVID,
} from "../../tests/fixtures/managedStringsAmbiguity.js";
import { validateManagedTokenScope } from "../domain/managed/managedInspectionEvidence.js";
import { compareManagedMembers } from "../domain/managed/managedMemberComparison.js";
import { readManagedMetadataLayout } from "../domain/managed/managedMetadataLayout.js";
import { readManagedPeLayout } from "../domain/managed/managedPeReader.js";
import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "./ManagedNativeBoundaryInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

it.each(["forward", "reverse"] as const)(
  "keeps the unnamed Module row and its GUIDs with %s #Strings declarations",
  (variant) => {
    const { bytes, nameIndex, duplicateHeader } =
      managedStringsAmbiguity(variant);
    const target = managedPeFixtureTarget(bytes);
    const artifact = inspectManagedArtifactBytes(bytes, target);
    const members = inspectManagedMembersBytes(bytes, target, {
      typeNames: ["Fixture.Program"],
    });
    const boundaries = inspectManagedNativeBoundariesBytes(bytes, target);
    const unnamed = {
      name: null,
      name_index: nameIndex,
      row_offset: expect.any(Number),
      token: "0x00000001",
      generation: 2,
      mvid: STRING_AMBIGUITY_MVID,
      enc_id: STRING_AMBIGUITY_MVID,
      enc_base_id: null,
    };

    for (const report of [artifact, members, boundaries]) {
      expect(report).toMatchObject({
        module: null,
        metadata: {
          status: "partial",
          table_row_counts: { Module: 1 },
          unresolved_module_name: unnamed,
        },
        coverage: {
          state: "partial",
          issues: [
            {
              code: "invalid-stream",
              scope: "metadata.#Strings",
              offset: duplicateHeader,
              detail: expect.stringContaining("distinct byte ranges"),
            },
          ],
        },
      });
      expect(
        validateManagedTokenScope(
          report,
          "managed inspection",
          "normalized result",
        ).ok,
      ).toBe(true);
    }
    expect(members.identity_scope.requires_mvid).toBe(STRING_AMBIGUITY_MVID);
    expect(boundaries.identity_scope.requires_mvid).toBe(STRING_AMBIGUITY_MVID);
    expect(members.types).toEqual([]);
    expect(members.methods).toEqual([]);
  },
);

it.each([
  { variant: "alias", nilName: false, expected: "Fixture.dll" },
  { variant: "forward", nilName: true, expected: "" },
] as const)(
  "keeps the existing Module shape when its name is established ($variant)",
  ({ variant, nilName, expected }) => {
    const { bytes } = managedStringsAmbiguity(variant, { nilName });
    const report = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    expect(report.module).toMatchObject({
      name: expected,
      mvid: STRING_AMBIGUITY_MVID,
    });
    expect(report.metadata).not.toHaveProperty("unresolved_module_name");
    expect(report.identity_scope.requires_mvid).toBe(STRING_AMBIGUITY_MVID);
  },
);

it("does not derive a token scope from conflicting GUID spans or multiple Module rows", () => {
  for (const options of [{ ambiguousGuid: true }, { multipleModules: true }]) {
    const { bytes } = managedStringsAmbiguity("forward", options);
    const report = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    expect(report.module).toBeNull();
    expect(report.identity_scope.requires_mvid).toBeNull();
    if (options.ambiguousGuid === true)
      expect(report.metadata.unresolved_module_name).toMatchObject({
        mvid: null,
        enc_id: null,
      });
    else expect(report.metadata).not.toHaveProperty("unresolved_module_name");
  }
});

it.each(["forward", "reverse"] as const)(
  "withholds Module identity when a nil name bypasses %s string-heap ambiguity but Module rows conflict",
  (variant) => {
    const { bytes } = managedStringsAmbiguity(variant, {
      nilName: true,
      multipleModules: true,
    });
    const target = managedPeFixtureTarget(bytes);
    const artifact = inspectManagedArtifactBytes(bytes, target);
    const members = inspectManagedMembersBytes(bytes, target);
    const boundaries = inspectManagedNativeBoundariesBytes(bytes, target);

    for (const report of [artifact, members, boundaries]) {
      expect(report.module).toBeNull();
      expect(report.metadata).toMatchObject({
        status: "partial",
        table_row_counts: { Module: 2, TypeDef: 1, MethodDef: 1 },
      });
      expect(report.metadata).not.toHaveProperty("unresolved_module_name");
      expect(report.coverage.issues).toContainEqual(
        expect.objectContaining({
          code: "invalid-row",
          scope: "metadata.Module",
        }),
      );
    }
    expect(members.identity_scope.requires_mvid).toBeNull();
    expect(boundaries.identity_scope.requires_mvid).toBeNull();
  },
);

it("keeps an independent MVID beside an invalid ENC index", () => {
  const { bytes } = managedStringsAmbiguity("forward", { invalidEnc: true });
  const report = inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );
  expect(report.metadata.unresolved_module_name).toMatchObject({
    mvid: STRING_AMBIGUITY_MVID,
    enc_id: null,
  });
  expect(report.coverage.issues).toContainEqual(
    expect.objectContaining({
      code: "invalid-guid",
      scope: "metadata.#GUID",
    }),
  );
});

it.each([1, 2])(
  "retains the MVID beside an invalid name only when the Module row is unique (rows: %i)",
  (moduleRowCount) => {
    const bytes = buildManagedPeFixture({ moduleRowCount });
    const pe = readManagedPeLayout(bytes);
    if (pe.cli === null) throw new Error("Fixture omitted CLI metadata");
    const { size, rva } = pe.cli.metadata;
    const root = pe.rvaToOffset(rva, size, "fixture metadata");
    const module = readManagedMetadataLayout(bytes, root, size).table(0);
    if (module === undefined) throw new Error("Fixture omitted its Module row");
    const nameIndex = 0xffff;
    bytes.writeUInt16LE(nameIndex, module.offset + 2);

    const target = managedPeFixtureTarget(bytes);
    const artifact = inspectManagedArtifactBytes(bytes, target);
    const members = inspectManagedMembersBytes(bytes, target);
    const mvid =
      moduleRowCount === 1 ? "00112233-4455-6677-8899-aabbccddeeff" : null;
    for (const report of [artifact, members]) {
      expect(report.module).toBeNull();
      expect(report.metadata.status).toBe("partial");
      expect(report.coverage.issues).toContainEqual(
        expect.objectContaining({
          code: "invalid-heap-index",
          scope: "metadata.#Strings",
        }),
      );
      if (mvid === null) {
        expect(report.metadata).not.toHaveProperty("unresolved_module_name");
      } else {
        expect(report.metadata.unresolved_module_name).toEqual({
          name: null,
          name_index: nameIndex,
          generation: 0,
          mvid,
          enc_id: null,
          enc_base_id: null,
          token: "0x00000001",
          row_offset: module.offset,
        });
      }
    }
    expect(members.identity_scope.requires_mvid).toBe(mvid);
    expect(
      validateManagedTokenScope(members, "managed inspection", "fixture").ok,
    ).toBe(true);
    const namedBytes = buildManagedPeFixture();
    const named = inspectManagedMembersBytes(
      namedBytes,
      managedPeFixtureTarget(namedBytes),
    );
    const comparison = compareManagedMembers(
      { evidenceId: "ev_" + "a".repeat(64), result: named },
      { evidenceId: "ev_" + "b".repeat(64), result: members },
    );
    expect(comparison.right).toMatchObject({
      mvid,
      module_name: null,
      metadata_status: "partial",
    });
  },
);

it("treats a duplicate #Strings extent outside the root as malformed", () => {
  const { bytes, metadataEnd } = managedStringsAmbiguity("outside-root");
  const report = inspectManagedArtifactBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );
  expect(report.metadata.status).toBe("malformed");
  expect(report.metadata).not.toHaveProperty("unresolved_module_name");
  expect(report.coverage.issues).toContainEqual({
    code: "invalid-metadata-root",
    scope: "metadata.#Strings",
    offset: metadataEnd,
    detail: "metadata.#Strings leaves the metadata byte range",
  });
});

it("rejects conflicting Module projections while preserving known MVIDs in comparisons", () => {
  const { bytes } = managedStringsAmbiguity("forward");
  const unnamed = inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );
  const namedBytes = buildManagedPeFixture();
  const named = inspectManagedMembersBytes(
    namedBytes,
    managedPeFixtureTarget(namedBytes),
  );
  expect(named.metadata).not.toHaveProperty("unresolved_module_name");

  for (const altered of [
    { ...unnamed, module: named.module },
    {
      ...unnamed,
      identity_scope: { ...unnamed.identity_scope, requires_mvid: null },
    },
  ]) {
    expect(
      validateManagedTokenScope(altered, "inspect_managed_members", "altered")
        .ok,
    ).toBe(false);
  }

  const comparison = compareManagedMembers(
    { evidenceId: "ev_" + "a".repeat(64), result: named },
    { evidenceId: "ev_" + "b".repeat(64), result: unnamed },
  );
  expect(comparison.right).toMatchObject({
    mvid: STRING_AMBIGUITY_MVID,
    module_name: null,
    metadata_status: "partial",
  });
  expect(comparison.methods).toEqual([
    expect.objectContaining({ status: "unknown" }),
  ]);
});
