import * as inventoryProducer from "../domain/managed/managedMetadataInventory.js";
import { describe, expect, it, vi } from "vitest";

import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "./ManagedNativeBoundaryInspector.js";
import {
  buildManagedPeFixture,
  buildNativePeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

it("preserves a readable native declaration when inventory issue count exceeds call-argument capacity", () => {
  const original = inventoryProducer.readManagedMetadataInventory;
  const issue = {
    code: "invalid-row" as const,
    scope: "metadata.CustomAttribute:fixture",
    offset: 0,
    detail: "Controlled invalid constructor",
  };
  const issueCount = 150_000;
  const producer = vi
    .spyOn(inventoryProducer, "readManagedMetadataInventory")
    .mockImplementation((...args) => ({
      ...original(...args),
      issues: Array.from({ length: issueCount }, () => issue),
    }));
  try {
    const bytes = buildManagedPeFixture({
      targetFramework: null,
      pinvoke: { importName: "Observe" },
    });
    const result = inspectManagedNativeBoundariesBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    expect(result.pinvoke_imports[0]?.import_name).toBe("Observe");
    expect(result.coverage.state).toBe("partial");
    expect(
      result.coverage.issues.reduce(
        (count, observed) => count + Number(observed.scope === issue.scope),
        0,
      ),
    ).toBe(issueCount);
    expect(result.coverage.issues[0]).toEqual(issue);
    expect(result.coverage.issues[issueCount - 1]).toEqual(issue);
  } finally {
    producer.mockRestore();
  }
});

describe("managed artifact failure classification", () => {
  it("distinguishes absent metadata from malformed signatures and table masks", () => {
    const nativeBytes = buildNativePeFixture();
    const native = inspectManagedArtifactBytes(
      nativeBytes,
      managedPeFixtureTarget(nativeBytes),
    );
    expect(native).toMatchObject({
      classification: { status: "not-managed" },
      metadata: { status: "absent" },
      coverage: { state: "unavailable" },
    });

    const malformedBytes = buildManagedPeFixture({
      corruptMetadataSignature: true,
    });
    const malformed = inspectManagedArtifactBytes(
      malformedBytes,
      managedPeFixtureTarget(malformedBytes),
    );
    expect(malformed.classification.status).toBe("malformed");
    expect(malformed.coverage.issues).toEqual([
      expect.objectContaining({ code: "invalid-metadata-root" }),
    ]);

    const invalidTableBytes = buildManagedPeFixture({
      metadataValidMaskExtra: 1n << 50n,
    });
    const invalidTables = inspectManagedArtifactBytes(
      invalidTableBytes,
      managedPeFixtureTarget(invalidTableBytes),
    );
    expect(invalidTables).toMatchObject({
      classification: { status: "malformed" },
      coverage: {
        state: "partial",
        issues: [{ code: "invalid-tables", scope: "metadata.valid-mask" }],
      },
    });
  });

  it("rejects a ReadyToRun OS-override machine without a CLI directory", () => {
    const bytes = buildNativePeFixture();
    bytes.writeUInt16LE(0x014c ^ 0x7b79, bytes.readUInt32LE(0x3c) + 4);
    expect(() =>
      inspectManagedArtifactBytes(bytes, managedPeFixtureTarget(bytes)),
    ).toThrow("Unsupported PE machine 0x7a35");
  });

  it("keeps readable duplicate references and both declined rows in artifact and members", () => {
    const bytes = buildManagedPeFixture({
      references: [
        "System.Runtime",
        "System.Runtime",
        "UnityEngine.CoreModule",
      ],
      malformedAssemblyReferenceRows: [3],
      malformedCustomAttributeRows: [1],
    });
    const target = managedPeFixtureTarget(bytes);
    const artifact = inspectManagedArtifactBytes(bytes, target);
    const members = inspectManagedMembersBytes(bytes, target);
    const issueCodes = ["invalid-heap-index", "invalid-row"];

    expect(artifact.references.map(({ name }) => name)).toEqual([
      "System.Runtime",
      "System.Runtime",
    ]);
    expect(artifact.attributes).toEqual([]);
    expect(artifact.coverage.issues.map(({ code }) => code)).toEqual(
      issueCodes,
    );
    expect(members.coverage.issues.map(({ code }) => code)).toEqual(issueCodes);
  });
});

it("reports both invalid stream names at their relocated file offset", () => {
  const original = buildManagedPeFixture();
  const pe = original.readUInt32LE(0x3c);
  const section = pe + 24 + original.readUInt16LE(pe + 20);
  const rawOffset = original.readUInt32LE(section + 20);
  const relocated = Buffer.concat([
    original.subarray(0, rawOffset),
    Buffer.alloc(0x200),
    original.subarray(rawOffset),
  ]);
  relocated.writeUInt32LE(rawOffset + 0x200, section + 20);
  // The PE fixture places the metadata root at 0x300 before relocation
  // and the first table stream name 40 bytes into that root.
  const nameOffset = 0x528;
  expect(relocated.toString("ascii", nameOffset, nameOffset + 2)).toBe("#~");
  const baseline = inspectManagedArtifactBytes(
    relocated,
    managedPeFixtureTarget(relocated),
  );
  expect(baseline).toMatchObject({
    coverage: { state: "complete", issues: [] },
    metadata: {
      status: "complete",
      stream_names: expect.arrayContaining(["#~"]),
      table_row_counts: { Module: 1, MethodDef: 1 },
    },
  });

  for (const [value, length, detail] of [
    [0x1f, 1, "not printable ASCII"],
    [0x41, 32, "missing a bounded terminator"],
  ] as const) {
    const bytes = Buffer.from(relocated).fill(
      value,
      nameOffset,
      nameOffset + length,
    );
    const target = managedPeFixtureTarget(bytes);
    const issue = {
      code: "invalid-stream",
      scope: "metadata.stream-name",
      detail: expect.stringContaining(detail),
      offset: nameOffset,
    };
    const artifact = inspectManagedArtifactBytes(bytes, target);
    expect(artifact).toMatchObject({
      classification: {
        status: "malformed",
        evidence: expect.arrayContaining([
          expect.objectContaining({
            code: "metadata-not-admitted",
            file_offset: nameOffset,
          }),
        ]),
      },
      coverage: { issues: [issue] },
    });
    if (length === 32)
      expect(inspectManagedMembersBytes(bytes, target).coverage.issues).toEqual(
        [issue],
      );
  }
});
