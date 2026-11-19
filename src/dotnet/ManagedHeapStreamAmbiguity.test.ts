import { expect, it } from "vitest";

import { readManagedPeLayout } from "../domain/managed/managedPeReader.js";
import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "./ManagedNativeBoundaryInspector.js";
import {
  buildManagedPeFixture,
  fixtureUserStringHeap,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

const FIRST_MVID = "11111111-1111-1111-1111-111111111111";
const SECOND_MVID = "22222222-2222-2222-2222-222222222222";

type Variant = "forward" | "reverse" | "alias" | "outside-root";

const duplicateHeap = (
  bytes: Buffer,
  name: "#GUID" | "#US",
  alternateHeap: Buffer,
  variant: Variant,
) => {
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("Fixture omitted a CLI header");
  const size = pe.cli.metadata.size;
  const start = pe.rvaToOffset(pe.cli.metadata.rva, size, "fixture metadata");
  const original = Buffer.from(bytes.subarray(start, start + size));
  const streamCount = original.readUInt16LE(30);
  const headers: number[] = [];
  let heapHeader = -1;
  let end = 32;
  for (let index = 0; index < streamCount; index += 1) {
    headers.push(end);
    const terminator = original.indexOf(0, end + 8);
    if (original.toString("ascii", end + 8, terminator) === name)
      heapHeader = end;
    end = Math.ceil((terminator + 1) / 4) * 4;
  }
  if (heapHeader < 0) throw new Error(`Fixture omitted ${name}`);
  const headerSize = 8 + Math.ceil((name.length + 1) / 4) * 4;
  const alternate = size + headerSize;
  const extended = Buffer.alloc(
    variant === "alias" ? alternate : alternate + alternateHeap.byteLength,
  );
  original.copy(extended, 0, 0, end);
  original.copy(extended, end + headerSize, end);
  extended.writeUInt16LE(streamCount + 1, 30);
  for (const header of headers)
    extended.writeUInt32LE(original.readUInt32LE(header) + headerSize, header);
  const originalHeap = extended.readUInt32LE(heapHeader);
  const [first, second] = (
    {
      forward: [originalHeap, alternate],
      reverse: [alternate, originalHeap],
      alias: [originalHeap, originalHeap],
      "outside-root": [originalHeap, extended.length],
    } as const
  )[variant];
  if (variant !== "alias") alternateHeap.copy(extended, alternate);
  extended.writeUInt32LE(first, heapHeader);
  extended.writeUInt32LE(second, end);
  const originalSize = original.readUInt32LE(heapHeader + 4);
  extended.writeUInt32LE(
    variant === "reverse" ? alternateHeap.byteLength : originalSize,
    heapHeader + 4,
  );
  extended.writeUInt32LE(
    variant === "alias" || variant === "reverse"
      ? originalSize
      : alternateHeap.byteLength,
    end + 4,
  );
  extended.write(name, end + 8);
  bytes.set(extended, start);
  bytes.writeUInt32LE(extended.length, pe.cli.headerOffset + 12);

  return {
    bytes,
    duplicateHeader: start + end,
    firstHeader: start + heapHeader,
    firstRange: start + first,
    secondRange: start + second,
    metadataEnd: start + extended.length,
  };
};

const duplicateGuidFixture = (variant: Variant) =>
  duplicateHeap(
    buildManagedPeFixture({ mvid: Buffer.alloc(16, 0x11) }),
    "#GUID",
    Buffer.alloc(16, 0x22),
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
