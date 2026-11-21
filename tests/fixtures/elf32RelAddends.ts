import { elf32RelativeInitializers } from "../../src/native/initializers/NativeInitializers.fixture.js";

/**
 * Portable ET_REL carrier for elf-rel-addends/constructor.s. GNU as records
 * marker at section offset 1 and REL addends ffffffff, 00000001, 00000000.
 * No compiler or execution of the fixture is required by the regression.
 */
export const elf32RelAddends = (): Buffer => {
  const bytes = elf32RelativeInitializers();
  bytes.writeUInt16LE(1, 16); // ET_REL; section-relative relocation offsets.
  bytes.writeUInt32LE(0, 28);
  bytes.writeUInt16LE(0, 42);
  bytes.writeUInt16LE(0, 44); // No program headers in the object.
  bytes.set([0x90, 0xc3, 0x90], 0x80);
  bytes.writeUInt32LE(0xffffffff, 0x100);
  bytes.writeUInt32LE(1, 0x104);
  bytes.writeUInt32LE(0, 0x108);
  for (let index = 0; index < 3; index++) {
    bytes.writeUInt32LE(index * 4, 0x180 + index * 8);
    bytes.writeUInt32LE(0x101, 0x184 + index * 8); // symbol 1, R_386_32.
  }
  bytes.writeUInt32LE(1, 0x1b4); // marker's st_value.
  bytes.writeUInt32LE(2, 0x1b8); // marker's st_size.
  Buffer.from("marker\0").copy(bytes, 0x1d1);
  const section = (index: number) => 0x280 + index * 40;
  bytes.writeUInt32LE(0, section(1) + 12); // .text sh_addr.
  bytes.writeUInt32LE(3, section(1) + 20);
  bytes.writeUInt32LE(0, section(2) + 12); // .init_array sh_addr.
  bytes.writeUInt32LE(12, section(2) + 20);
  bytes.writeUInt32LE(0, section(4) + 8); // SHT_REL, not allocated.
  bytes.writeUInt32LE(0, section(4) + 12);
  bytes.writeUInt32LE(24, section(4) + 20);
  bytes.writeUInt32LE(5, section(4) + 24); // sh_link: .symtab.
  bytes.writeUInt32LE(2, section(4) + 28); // sh_info: .init_array.
  bytes.writeUInt32LE(1, section(5) + 28); // First non-local symbol.
  bytes.writeUInt32LE(8, section(6) + 20); // Full "\0marker\0" string table.
  return bytes;
};
