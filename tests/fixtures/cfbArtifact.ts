/** Source-generated empty MS-CFB v3 container; no installer or vendor artifact. */
export const emptyCfbArtifact = (): Buffer => {
  const bytes = Buffer.alloc(1536);
  Buffer.from("d0cf11e0a1b11ae1", "hex").copy(bytes);
  bytes.writeUInt16LE(0x3e, 24);
  bytes.writeUInt16LE(3, 26);
  bytes.writeUInt16LE(0xfffe, 28);
  bytes.writeUInt16LE(9, 30);
  bytes.writeUInt16LE(6, 32);
  bytes.writeUInt32LE(1, 44);
  bytes.writeUInt32LE(1, 48);
  bytes.writeUInt32LE(4096, 56);
  bytes.writeUInt32LE(0xfffffffe, 60);
  bytes.writeUInt32LE(0xfffffffe, 68);
  bytes.fill(0xff, 76, 512);
  bytes.writeUInt32LE(0, 76);
  bytes.fill(0xff, 512, 1024);
  bytes.writeUInt32LE(0xfffffffd, 512);
  bytes.writeUInt32LE(0xfffffffe, 516);
  const root = Buffer.from("Root Entry\0", "utf16le");
  root.copy(bytes, 1024);
  bytes.writeUInt16LE(root.length, 1088);
  bytes[1090] = 5;
  bytes[1091] = 1;
  for (const at of [1092, 1096, 1100]) bytes.writeUInt32LE(0xffffffff, at);
  bytes.writeUInt32LE(0xfffffffe, 1140);
  return bytes;
};
