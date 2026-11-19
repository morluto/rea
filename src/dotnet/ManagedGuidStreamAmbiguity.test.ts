import { expect, it } from "vitest";

import { readManagedPeLayout } from "../domain/managed/managedPeReader.js";
import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "./ManagedNativeBoundaryInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

const FIRST_MVID = "11111111-1111-1111-1111-111111111111";
const SECOND_MVID = "22222222-2222-2222-2222-222222222222";

const duplicateGuidFixture = (
  variant: "forward" | "reverse" | "alias" | "outside-root",
) => {
  const bytes = buildManagedPeFixture({ mvid: Buffer.alloc(16, 0x11) });
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("Fixture omitted a CLI header");
  const size = pe.cli.metadata.size;
  const start = pe.rvaToOffset(pe.cli.metadata.rva, size, "fixture metadata");
  const original = Buffer.from(bytes.subarray(start, start + size));
  const streamCount = original.readUInt16LE(30);
  const headers: number[] = [];
  let guidHeader = -1;
  let end = 32;
  for (let index = 0; index < streamCount; index += 1) {
    headers.push(end);
    const terminator = original.indexOf(0, end + 8);
    if (original.toString("ascii", end + 8, terminator) === "#GUID")
      guidHeader = end;
    end = Math.ceil((terminator + 1) / 4) * 4;
  }
  if (guidHeader < 0) throw new Error("Fixture omitted #GUID");
  // A #GUID declaration needs 16 bytes, including the four-byte name padding.
  const headerSize = 16;
  const alternate = size + headerSize;
  const extended = Buffer.alloc(
    variant === "alias" ? alternate : alternate + 16,
  );
  original.copy(extended, 0, 0, end);
  original.copy(extended, end + headerSize, end);
  extended.writeUInt16LE(streamCount + 1, 30);
  for (const header of headers)
    extended.writeUInt32LE(original.readUInt32LE(header) + headerSize, header);
  const originalGuid = extended.readUInt32LE(guidHeader);
  const [first, second] = (
    {
      forward: [originalGuid, alternate],
      reverse: [alternate, originalGuid],
      alias: [originalGuid, originalGuid],
      "outside-root": [originalGuid, extended.length],
    } as const
  )[variant];
  if (variant !== "alias") extended.fill(0x22, alternate);
  extended.writeUInt32LE(first, guidHeader);
  extended.writeUInt32LE(second, end);
  extended.writeUInt32LE(16, end + 4);
  extended.write("#GUID", end + 8);
  bytes.set(extended, start);
  bytes.writeUInt32LE(extended.length, pe.cli.headerOffset + 12);

  return {
    bytes,
    duplicateHeader: start + end,
    firstHeader: start + guidHeader,
    firstRange: start + first,
    secondRange: start + second,
    metadataEnd: start + extended.length,
  };
};

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
