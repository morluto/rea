import { expect, it } from "vitest";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

it("retains metadata handles without reporting calls or field accesses", () => {
  const il = Buffer.from([
    0xd0, 0x01, 0, 0, 0x06, 0x26, 0xd0, 0x01, 0, 0, 0x04, 0x26, 0x28, 0x01, 0,
    0, 0x0a, 0x7b, 0x01, 0, 0, 0x04, 0x26, 0x2a,
  ]);
  const bytes = buildManagedPeFixture({
    ilBody: Buffer.concat([Buffer.from([(il.length << 2) | 2]), il]),
  });
  const result = inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );
  expect(
    result.methods[0]?.body.anchors.map((anchor) => anchor.opcode),
  ).toEqual(["ldtoken", "ldtoken", "call", "ldfld"]);
  expect(result.call_edges.map((edge) => edge.opcode)).toEqual(["call"]);
  expect(result.field_accesses.map((access) => access.opcode)).toEqual([
    "ldfld",
  ]);
});
