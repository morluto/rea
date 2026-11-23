import { elf64PieInitializers } from "../../src/native/initializers/NativeInitializers.fixture.js";
import { aps2Table } from "./elfAndroidPacked.js";

/** Same known PIE slots as the ordinary fixture, with RELA packed as APS2. */
export const aps2InitializerImage = (): Buffer => {
  const base = elf64PieInitializers();
  const packed = aps2Table([
    4,
    0,
    4,
    8,
    0,
    0,
    0,
    0x200,
    8,
    0x100,
    8,
    8,
    0x10,
    8,
    (1n << 32n) | 1n,
    -0x110,
  ]);
  const bytes = Buffer.concat([base, packed]);
  bytes.writeBigUInt64LE(BigInt(bytes.length), 64 + 32);
  bytes.writeBigUInt64LE(BigInt(bytes.length), 64 + 40);
  const dynamic = 0x300 + 8 * 16;
  bytes.writeBigUInt64LE(0x60000011n, dynamic);
  bytes.writeBigUInt64LE(BigInt(base.length), dynamic + 8);
  bytes.writeBigUInt64LE(0x60000012n, dynamic + 16);
  bytes.writeBigUInt64LE(BigInt(packed.length), dynamic + 24);
  bytes.writeBigUInt64LE(21n, dynamic + 32);
  bytes.writeBigUInt64LE(0n, dynamic + 40);
  const section = 0x800 + 6 * 64;
  bytes.writeUInt32LE(0x60000002, section + 4);
  bytes.writeBigUInt64LE(BigInt(base.length), section + 16);
  bytes.writeBigUInt64LE(BigInt(base.length), section + 24);
  bytes.writeBigUInt64LE(BigInt(packed.length), section + 32);
  bytes.writeBigUInt64LE(1n, section + 56);
  return bytes;
};
