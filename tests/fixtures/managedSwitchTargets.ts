import { buildManagedPeFixture } from "../../src/dotnet/ManagedPe.fixture.js";

export const managedSwitchInstruction = (deltas: readonly number[]): Buffer => {
  const bytes = Buffer.alloc(5 + 4 * deltas.length);
  bytes[0] = 0x45;
  bytes.writeUInt32LE(deltas.length, 1);
  deltas.forEach((delta, index) => bytes.writeInt32LE(delta, 5 + index * 4));
  return bytes;
};

export const managedSwitchFixture = (
  il: Buffer,
  format: "tiny" | "fat" = "tiny",
): Buffer => {
  const header = Buffer.alloc(format === "tiny" ? 1 : 12);
  if (format === "tiny") header[0] = (il.length << 2) | 2;
  else {
    header.writeUInt16LE(0x3003, 0);
    header.writeUInt16LE(8, 2);
    header.writeUInt32LE(il.length, 4);
  }
  return buildManagedPeFixture({
    ilBody: Buffer.concat([header, il]),
    methodSignature: Buffer.from([0x00, 0x01, 0x01, 0x08]),
  });
};
