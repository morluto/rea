import { expect, it } from "vitest";

import { readManagedPeLayout } from "../domain/managed/managedPeReader.js";
import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "./ManagedNativeBoundaryInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

const tableHeaderLocations = (bytes: Buffer) => {
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("Fixture omitted CLI metadata");
  const root = pe.rvaToOffset(
    pe.cli.metadata.rva,
    pe.cli.metadata.size,
    "fixture metadata",
  );
  // The fixture emits the two four-byte table names before the other streams.
  return {
    firstHeader: root + 32,
    secondHeader: root + 44,
    metadataEnd: root + pe.cli.metadata.size,
  };
};

it.each(["#~", "#-"] as const)(
  "reads complete rows from a single %s table stream",
  (tableStreamName) => {
    const bytes = buildManagedPeFixture({ tableStreamName });
    const target = managedPeFixtureTarget(bytes);
    const artifact = inspectManagedArtifactBytes(bytes, target);
    const members = inspectManagedMembersBytes(bytes, target);
    expect(artifact.metadata).toMatchObject({
      status: "complete",
      stream_names: expect.arrayContaining([tableStreamName]),
      table_row_counts: { Module: 1, MethodDef: 1 },
    });
    expect(members.coverage.state).toBe("complete");
    expect(members.methods).toHaveLength(1);
    expect(members.module?.mvid).toBeTruthy();
  },
);

it.each([
  ["#~", "distinct"],
  ["#-", "distinct"],
  ["#~", "alias"],
] as const)(
  "preserves only independent facts with %s first and a %s table declaration",
  (tableStreamName, competingTableStream) => {
    const bytes = buildManagedPeFixture({
      tableStreamName,
      competingTableStream,
    });
    const { firstHeader, secondHeader } = tableHeaderLocations(bytes);
    const target = managedPeFixtureTarget(bytes);
    const artifact = inspectManagedArtifactBytes(bytes, target);
    const members = inspectManagedMembersBytes(bytes, target, {
      typeNames: ["Fixture.Program"],
    });
    const boundaries = inspectManagedNativeBoundariesBytes(bytes, target);
    const issue = {
      code: "unsupported-metadata",
      scope: "metadata.tables",
      detail: expect.stringContaining("Metadata row layout is unknown."),
      offset: secondHeader,
    };
    expect(artifact).toMatchObject({
      classification: { status: "managed" },
      metadata: { stream_names: expect.arrayContaining(["#~", "#-"]) },
      assembly: null,
      coverage: { state: "partial", issues: [issue] },
    });
    const observed = artifact.coverage.issues[0]?.detail;
    expect(observed).toContain(`${tableStreamName} at header ${firstHeader}`);
    expect(observed).toContain(
      `${tableStreamName === "#~" ? "#-" : "#~"} at header ${secondHeader}`,
    );
    for (const report of [artifact, members, boundaries]) {
      expect(report).toMatchObject({
        artifact: { sha256: target.sha256 },
        metadata: {
          status: "partial",
          version: "v4.0.30319",
          table_row_counts: {},
        },
        module: null,
      });
    }
    for (const report of [members, boundaries]) {
      expect(report).toMatchObject({
        identity_scope: { requires_mvid: null },
        coverage: { state: "unavailable", issues: [issue] },
      });
    }
    expect(members).toMatchObject({
      methods: [],
      fields: [],
      method_rows: null,
      selection: { type_names: ["Fixture.Program"], unmatched_type_names: [] },
    });
    expect(boundaries.pinvoke_imports).toEqual([]);
  },
);

it("validates a competing declaration's extent before resolving table ambiguity", () => {
  const bytes = buildManagedPeFixture({ competingTableStream: "outside-root" });
  const artifact = inspectManagedArtifactBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );
  expect(artifact.metadata.status).toBe("malformed");
  expect(artifact.coverage.issues).toContainEqual({
    code: "invalid-metadata-root",
    scope: "metadata.#-",
    detail: "metadata.#- leaves the metadata byte range",
    offset: tableHeaderLocations(bytes).metadataEnd,
  });
});
