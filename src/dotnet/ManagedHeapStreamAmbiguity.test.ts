import { expect, it } from "vitest";

import {
  duplicateManagedHeap as duplicateHeap,
  type DuplicateHeapVariant as Variant,
} from "../../tests/fixtures/managedDuplicateMetadataHeap.js";
import { readManagedMetadataLayout } from "../domain/managed/managedMetadataLayout.js";
import { readManagedPeLayout } from "../domain/managed/managedPeReader.js";
import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "./ManagedNativeBoundaryInspector.js";
import {
  buildManagedPeFixture,
  fixtureUserStringHeap,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

const FIRST_MVID = "67452301-ab89-efcd-1032-547698badcfe";
const SECOND_MVID = "98badcfe-5476-1032-efcd-ab8967452301";

const duplicateGuidFixture = (variant: Variant) =>
  duplicateHeap(
    buildManagedPeFixture({
      mvid: Buffer.from("0123456789abcdef1032547698badcfe", "hex"),
    }),
    "#GUID",
    Buffer.from("fedcba9876543210efcdab8967452301", "hex"),
    variant,
  );

it.each([
  ["forward", null],
  ["reverse", null],
  ["alias", FIRST_MVID],
] as const)(
  "preserves independent metadata with %s #GUID declarations",
  (variant, mvid) => {
    const { bytes, duplicateHeader, firstHeader, firstRange, secondRange } =
      duplicateGuidFixture(variant);
    const target = managedPeFixtureTarget(bytes);
    const artifact = inspectManagedArtifactBytes(bytes, target);
    const members = inspectManagedMembersBytes(bytes, target);
    const boundaries = inspectManagedNativeBoundariesBytes(bytes, target);
    const scope = "metadata.#GUID";
    const issue = {
      code: "invalid-stream",
      scope,
      offset: duplicateHeader,
      detail: expect.stringContaining(
        variant === "alias" ? "same byte range" : "distinct byte ranges",
      ),
    };

    for (const report of [artifact, members, boundaries]) {
      expect(report).toMatchObject({
        artifact: { sha256: target.sha256 },
        metadata: {
          status: "partial",
          table_row_counts: { Module: 1, TypeDef: 1, MethodDef: 1 },
        },
        module: {
          name: "Fixture.dll",
          token: "0x00000001",
          generation: 0,
          mvid,
          enc_id: null,
          enc_base_id: null,
        },
      });
      const issues = report.coverage.issues.filter(
        (item) => item.scope === scope,
      );
      expect(issues).toEqual([issue]);
      expect(issues[0]?.detail).toContain(
        `header ${firstHeader} (offset ${firstRange}, size 16), header ${duplicateHeader} (offset ${secondRange}, size 16)`,
      );
    }
    expect(members.identity_scope.requires_mvid).toBe(mvid);
    expect(boundaries.identity_scope.requires_mvid).toBe(mvid);
    expect(
      members.types.some(({ full_name }) => full_name === "Fixture.Program"),
    ).toBe(true);
    expect(members.methods).toHaveLength(1);
    if (variant !== "alias") {
      for (const report of [artifact, members, boundaries]) {
        expect(JSON.stringify(report)).not.toContain(FIRST_MVID);
        expect(JSON.stringify(report)).not.toContain(SECOND_MVID);
      }
    }
  },
);

it("rejects a duplicate #GUID declaration whose extent leaves the metadata root", () => {
  const { bytes, metadataEnd } = duplicateGuidFixture("outside-root");
  const target = managedPeFixtureTarget(bytes);

  for (const inspect of [
    inspectManagedArtifactBytes,
    inspectManagedMembersBytes,
    inspectManagedNativeBoundariesBytes,
  ]) {
    const report = inspect(bytes, target);
    expect(report.metadata.status).toBe("malformed");
    expect(report.module).toBeNull();
    expect(report.coverage.issues).toContainEqual({
      code: "invalid-metadata-root",
      scope: "metadata.#GUID",
      detail: "metadata.#GUID leaves the metadata byte range",
      offset: metadataEnd,
    });
  }
});

const duplicateUserStringFixture = (variant: Variant) => {
  const {
    heap,
    tokens: [token],
  } = fixtureUserStringHeap(["one"]);
  if (token === undefined) throw new Error("Fixture omitted a user string");
  // ldstr, pop, ret in a tiny method body.
  const ilBody = Buffer.from([0x1e, 0x72, 0, 0, 0, 0, 0x26, 0x2a]);
  ilBody.writeUInt32LE(Number.parseInt(token, 16), 2);

  return {
    token,
    ...duplicateHeap(
      buildManagedPeFixture({ ilBody, userStringHeap: heap }),
      "#US",
      fixtureUserStringHeap(["two"]).heap,
      variant,
    ),
  };
};

it.each(["forward", "reverse", "alias"] as const)(
  "preserves member facts with %s #US declarations",
  (variant) => {
    const { bytes, token, duplicateHeader, firstRange } =
      duplicateUserStringFixture(variant);
    const target = managedPeFixtureTarget(bytes);
    const members = inspectManagedMembersBytes(bytes, target);
    expect(members.metadata.status).toBe("complete");
    expect(members.coverage).toEqual({ state: "complete", issues: [] });
    expect(members.methods[0]?.body.anchors[0]).toMatchObject({
      opcode: "ldstr",
      operand: token,
    });
    expect(members.user_strings).toEqual({
      state: "partial",
      literals:
        variant === "alias"
          ? [{ token, offset: firstRange + 1, value: "one" }]
          : [],
      issues: [
        {
          code: "invalid-stream",
          scope: "metadata.#US",
          offset: duplicateHeader,
          detail: expect.stringContaining(
            variant === "alias" ? "same byte range" : "distinct byte ranges",
          ),
        },
      ],
    });
    expect(inspectManagedArtifactBytes(bytes, target).metadata.status).toBe(
      "complete",
    );
    expect(
      inspectManagedNativeBoundariesBytes(bytes, target).metadata.status,
    ).toBe("complete");
  },
);

it("rejects a duplicate #US declaration outside the metadata root", () => {
  const { bytes, metadataEnd } = duplicateUserStringFixture("outside-root");
  const members = inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );
  expect(members.metadata.status).toBe("malformed");
  expect(members.coverage.issues).toContainEqual({
    code: "invalid-metadata-root",
    scope: "metadata.#US",
    detail: "metadata.#US leaves the metadata byte range",
    offset: metadataEnd,
  });
  expect(members.user_strings).toBeNull();
});

const duplicateBlobFixture = (
  variant: Variant,
  options: Parameters<typeof buildManagedPeFixture>[0] = {},
  nonzeroPublicKey = false,
) => {
  const bytes = buildManagedPeFixture({
    fieldRowCount: 1,
    references: ["UnityEngine.CoreModule"],
    pinvoke: { importName: "get_value", moduleName: "fixture.dll" },
    ...options,
  });
  if (nonzeroPublicKey) {
    const pe = readManagedPeLayout(bytes);
    if (pe.cli === null) throw new Error("Fixture omitted CLI metadata");
    const { rva, size } = pe.cli.metadata;
    const offset = pe.rvaToOffset(rva, size, "fixture metadata");
    const layout = readManagedMetadataLayout(bytes, offset, size);
    const assembly = layout.table(32);
    if (assembly === undefined)
      throw new Error("Fixture omitted Assembly metadata");
    // Assembly.PublicKey follows the hash algorithm, version, and flags.
    bytes.writeUInt16LE(1, assembly.offset + 16);
  }
  return duplicateHeap(bytes, "#Blob", Buffer.from([0, 3, 0, 0, 1]), variant);
};

it.each(["forward", "reverse", "alias"] as const)(
  "preserves independent metadata with %s #Blob declarations",
  (variant) => {
    const { bytes, duplicateHeader } = duplicateBlobFixture(variant);
    const target = managedPeFixtureTarget(bytes);
    const artifact = inspectManagedArtifactBytes(bytes, target);
    const members = inspectManagedMembersBytes(bytes, target);
    const boundaries = inspectManagedNativeBoundariesBytes(bytes, target);
    for (const report of [artifact, members, boundaries]) {
      expect(report).toMatchObject({
        metadata: {
          status: "partial",
          table_row_counts: { Module: 1, Assembly: 1, MethodDef: 1, Field: 1 },
        },
        module: { name: "Fixture.dll", mvid: expect.any(String) },
        coverage: { state: "partial" },
      });
      expect(
        report.coverage.issues.filter(
          ({ scope }) => scope === "metadata.#Blob",
        ),
      ).toEqual([
        {
          code: "invalid-stream",
          scope: "metadata.#Blob",
          offset: duplicateHeader,
          detail: expect.stringContaining(
            variant === "alias" ? "same byte range" : "distinct byte ranges",
          ),
        },
      ]);
    }
    expect(artifact.classification.evidence).toContainEqual(
      expect.objectContaining({ code: "unity-reference-observed" }),
    );
    expect(artifact.assembly).toMatchObject({
      name: "Fixture.Managed",
      public_key: { kind: "none", byte_length: 0, sha256: null, token: null },
    });
    expect(members.types).toContainEqual(
      expect.objectContaining({ full_name: "Fixture.Program" }),
    );
    expect(boundaries.pinvoke_imports).toContainEqual(
      expect.objectContaining({ import_name: "get_value" }),
    );
    if (variant === "alias") {
      expect(artifact.references).toContainEqual(
        expect.objectContaining({ name: "UnityEngine.CoreModule" }),
      );
      expect(members.methods[0]?.signature.parse_status).toBe("decoded");
      expect(members.fields[0]?.signature.parse_status).toBe("decoded");
    } else {
      expect(artifact.references).toEqual([]);
      expect(artifact.attributes).toEqual([]);
      expect(members.fields).toEqual([]);
      expect(members.methods).toEqual([]);
      expect(members.member_refs).toEqual([]);
      expect(members.method_rows).toEqual({ offset: 0, count: 1, total: 1 });
    }
  },
);

it("withholds a nonzero Assembly public key without claiming the key is absent", () => {
  const { bytes } = duplicateBlobFixture("forward", {}, true);
  const report = inspectManagedArtifactBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );
  expect(report.module?.mvid).toBeTruthy();
  expect(report.assembly).toBeNull();
  expect(report.metadata.status).toBe("partial");
  expect(report.metadata.table_row_counts.Assembly).toBe(1);
});

it("preserves a decoded body while its nonzero locals blob is unresolved", () => {
  const original = buildManagedPeFixture({
    methodSignature: Buffer.alloc(0),
    // Fat header with a one-byte ret body and a StandAloneSig row-1 token.
    ilBody: Buffer.from([0x03, 0x30, 8, 0, 1, 0, 0, 0, 1, 0, 0, 0x11, 0x2a]),
    standaloneSignatures: [Buffer.from([0x07, 0x01, 0x08])],
  });
  const { bytes } = duplicateHeap(
    original,
    "#Blob",
    Buffer.from([0, 1, 0]),
    "forward",
  );
  const report = inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );
  expect(report.methods[0]).toMatchObject({
    signature: { raw_length: 0 },
    body: {
      status: "partial",
      local_var_sig_token: "0x11000001",
      local_var_signature: null,
      anchors: [{ opcode: "ret" }],
    },
  });
});

it("validates the extent of a later #Blob declaration before observing metadata", () => {
  const { bytes, metadataEnd } = duplicateBlobFixture("outside-root");
  const report = inspectManagedArtifactBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );
  expect(report.metadata.status).toBe("malformed");
  expect(report.coverage.issues).toContainEqual({
    code: "invalid-metadata-root",
    scope: "metadata.#Blob",
    detail: "metadata.#Blob leaves the metadata byte range",
    offset: metadataEnd,
  });
});
