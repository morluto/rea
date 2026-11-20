import { buildManagedPeFixture } from "../../src/dotnet/ManagedPe.fixture.js";

/** Large member inventories with one small, nonempty type available for selection. */
export const buildManagedMemberSelectionCapacityFixture = (
  additionalEmptyTypes = 9400,
): Buffer =>
  buildManagedPeFixture({
    additionalEmptyTypes,
    fieldRowCount: 40037,
    methodRowCount: 49738,
    memberRefRowCount: 11442,
    customAttributeRowCount: 58698,
    distinctMemberNames: true,
    firstTypeFieldRowCount: 1,
    firstTypeMethodRowCount: 1,
  });

/** Valid dense CIL exceeds the unchanged decoding bound, after TypeDef admission. */
export const buildManagedMemberCapacityFixture = (
  options: Parameters<typeof buildManagedPeFixture>[0] = {},
): Buffer => {
  const il = Buffer.alloc(270_001);
  il[il.length - 1] = 0x2a;
  const header = Buffer.alloc(12);
  header.writeUInt16LE(0x3003);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(il.length, 4);
  return buildManagedPeFixture({
    additionalEmptyTypes: 2,
    ...options,
    ilBody: Buffer.concat([header, il]),
  });
};
