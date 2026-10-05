import { expect, it } from "vitest";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

it.each([
  Buffer.alloc(0),
  Buffer.from([0]),
  Buffer.from([0, 0, 0x12]),
  Buffer.from([0x10, 0x80]),
  Buffer.from([0, 0xe0]),
])(
  "marks incomplete or reserved method signatures malformed: %j",
  (methodSignature) => {
    const bytes = buildManagedPeFixture({ methodSignature });
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    expect(result.methods[0]?.signature).toMatchObject({
      parse_status: "malformed",
      kind: "unknown",
    });
  },
);

it("keeps an admitted but unimplemented element type unsupported", () => {
  // ECMA-335 ELEMENT_TYPE_ARRAY is valid, but multidimensional arrays are not decoded here.
  const bytes = buildManagedPeFixture({
    fieldSignature: Buffer.from([6, 0x14, 8, 1, 0, 0]),
  });
  const result = inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );
  expect(result.fields[0]?.signature).toMatchObject({
    parse_status: "unsupported",
    issue: "unsupported element type 0x14",
  });
});
