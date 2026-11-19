/** Generate a public source-owned COM fixture; no external compiler or game input. */
export const buildDosComFixture = () => {
  const bytes = Buffer.alloc(64, 0x90);
  // Two MOV AH,imm8 / INT 21h instructions reach ComLoader's score of 12.
  // The near call targets file offset 0x20; INT 20h terminates the entry.
  bytes.set(Buffer.from("b409cd21b409cd21e81500cd20", "hex"));
  bytes.set(Buffer.from("40c3", "hex"), 0x20);
  return {
    bytes,
    entry: "0x100",
    near: "0x120",
    entry_hex: "b409",
    load_segment: "0x0",
    load_address: "0000:0100",
    loader: "ComLoader",
    unlisted: "0x13f",
    tail: "0x13e",
  };
};

/** A .com image ComLoader's recognition score rejects. */
export const buildRejectedDosComFixture = () => {
  const bytes = Buffer.alloc(64, 0x90);
  bytes.set(Buffer.from("b83412e81a00cd20", "hex"));
  bytes.set(Buffer.from("40c3", "hex"), 32);
  return {
    bytes,
    entry: "0x10100",
    near: "0x10120",
    load_address: "1000:0100",
    loader: "BinaryLoader",
    fallback_reason: "recognition_score",
  };
};
