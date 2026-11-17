import { describe, expect, it } from "vitest";

import { readManagedPeLayout } from "../domain/managed/managedPeReader.js";
import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

/** File offsets of each stream header's name, in header order. */
const streamHeaderNames = (
  bytes: Buffer,
): { readonly name: string; readonly headerOffset: number }[] => {
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("Fixture omitted CLI metadata");
  const root = pe.rvaToOffset(
    pe.cli.metadata.rva,
    pe.cli.metadata.size,
    "cli.metadata",
  );
  const versionLength = bytes.readUInt32LE(root + 12);
  let cursor = root + Math.ceil((16 + versionLength) / 4) * 4;
  const count = bytes.readUInt16LE(cursor + 2);
  cursor += 4;
  const headers: { name: string; headerOffset: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const end = bytes.indexOf(0, cursor + 8);
    headers.push({
      name: bytes.toString("latin1", cursor + 8, end),
      headerOffset: cursor,
    });
    cursor = cursor + 8 + Math.ceil((end - (cursor + 8) + 1) / 4) * 4;
  }
  return headers;
};

describe("repeated metadata stream headers", () => {
  it("admits the first header of a repeated name and reports the later one", () => {
    const bytes = buildManagedPeFixture();
    const target = managedPeFixtureTarget(bytes);
    const baseline = inspectManagedArtifactBytes(bytes, target);
    const baselineMembers = inspectManagedMembersBytes(bytes, target);
    expect(baseline.coverage).toEqual({ state: "complete", issues: [] });

    // Obfuscators append a decoy header that repeats an earlier name. Rename the
    // later #Blob header to #GUID: same length, so no other byte moves.
    const headers = streamHeaderNames(bytes);
    const guid = headers.findIndex((header) => header.name === "#GUID");
    const blob = headers.findIndex((header) => header.name === "#Blob");
    expect(guid).toBeGreaterThanOrEqual(0);
    expect(blob).toBeGreaterThan(guid);
    const decoy = headers[blob];
    if (decoy === undefined) throw new Error("Fixture omitted #Blob");
    const mutated = Buffer.from(bytes);
    mutated.write("#GUID", decoy.headerOffset + 8, "latin1");
    const mutatedTarget = managedPeFixtureTarget(mutated);

    const artifact = inspectManagedArtifactBytes(mutated, mutatedTarget);
    const members = inspectManagedMembersBytes(mutated, mutatedTarget);

    // Before the fix the whole metadata was rejected as malformed.
    expect(artifact.metadata.status).not.toBe("malformed");
    expect(artifact.coverage.issues).toContainEqual(
      expect.objectContaining({
        code: "invalid-stream",
        scope: "metadata.stream-header",
        offset: decoy.headerOffset,
        detail: expect.stringContaining("Duplicate metadata stream #GUID ignored"),
      }),
    );
    // Facts backed by the first #GUID and by #Strings are unchanged.
    expect(artifact.module).toEqual(baseline.module);
    expect(members.types.length).toBe(baselineMembers.types.length);
    expect(members.coverage.issues).toContainEqual(
      expect.objectContaining({
        scope: "metadata.stream-header",
        offset: decoy.headerOffset,
      }),
    );
  });
});
