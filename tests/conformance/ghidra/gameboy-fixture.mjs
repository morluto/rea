/** Self-owned synthetic cartridge; no game bytes or emulator execution. */
export const buildGameBoyRom = ({ banks = 4, cgb = false } = {}) => {
  const sizeCodes = new Map([
    [72, 0x52],
    [80, 0x53],
    [96, 0x54],
  ]);
  if (
    ![2, 4, 8, 16, 32, 64, 128, 256, 512, ...sizeCodes.keys()].includes(banks)
  )
    throw new Error("Invalid fixture bank count");
  const rom = Buffer.alloc(banks * 0x4000, 0xff);
  rom.set([0, 0xc3, 0x50, 1], 0x100);
  rom.set(
    Buffer.from(
      "ceed6666cc0d000b03730083000c000d0008111f8889000edccc6ee6ddddd999bbbb67636e0eecccdddc999fbbb9333e",
      "hex",
    ),
    0x104,
  );
  rom.fill(0, 0x134, 0x150);
  rom.write("REA TEST", 0x134, "ascii");
  rom[0x143] = cgb ? 0xc0 : 0;
  rom[0x147] = banks === 2 ? 0 : 0x19;
  rom[0x148] = sizeCodes.get(banks) ?? Math.log2(banks / 2);
  // LDH, LD (HL+), and SWAP distinguish SM83 from ordinary Z80 decoding.
  rom.set(
    [
      0x3e, 0x12, 0xe0, 0x80, 0x21, 0, 0xc0, 0x22, 0xcb, 0x37, 0xcd, 0x80, 1,
      0xc9,
    ],
    0x150,
  );
  rom.set([0x3e, 0x2a, 0xc9], 0x180);
  for (let bank = 1; bank < banks; bank++)
    rom.set([0x3e, bank, 0xc9], bank * 0x4000);
  let checksum = 0;
  for (let i = 0x134; i <= 0x14c; i++)
    checksum = (checksum - rom[i] - 1) & 0xff;
  rom[0x14d] = checksum;
  let global = 0;
  for (let i = 0; i < rom.length; i++)
    if (i !== 0x14e && i !== 0x14f) global = (global + rom[i]) & 0xffff;
  rom.writeUInt16BE(global, 0x14e);
  return rom;
};
