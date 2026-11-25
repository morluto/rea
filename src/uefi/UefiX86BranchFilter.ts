import { BinaryReader } from "../domain/binaryContainer.js";
/**
 * Decode the x86 BCJ transform over a complete stream at instruction pointer
 * zero, as used by EDK II's LZMAF86 handler. The transform is size-preserving.
 *
 * Adapted from Igor Pavlov's public-domain Bra86.c (2017-04-03), pinned at
 * https://github.com/tianocore/edk2/blob/556dcfb466e9f05affeaff881d738807f8156d3c/MdeModulePkg/Library/LzmaCustomDecompressLib/Sdk/C/Bra86.c
 */
export function undoUefiX86BranchFilter(bytes: Buffer): void {
  const reader = new BinaryReader(bytes, true, "x86 BCJ stream");
  const lastOpcode = bytes.length - 5;
  let position = 0;
  // Records nearby nonconverted opcode bytes that may overlap an operand.
  let priorOpcodeMask = 0;
  while (position <= lastOpcode) {
    const searchStart = position;
    while (position <= lastOpcode && (reader.u8(position) & 0xfe) !== 0xe8) {
      position += 1;
    }
    if (position > lastOpcode) break;

    const distance = position - searchStart;
    priorOpcodeMask = distance > 2 ? 0 : priorOpcodeMask >>> distance;
    if (
      (priorOpcodeMask !== 0 &&
        (priorOpcodeMask > 4 ||
          priorOpcodeMask === 3 ||
          isSignByte(reader.u8(position + (priorOpcodeMask >>> 1) + 1)))) ||
      !isSignByte(reader.u8(position + 4))
    ) {
      priorOpcodeMask = (priorOpcodeMask >>> 1) | 4;
      position += 1;
      continue;
    }

    const nextInstruction = position + 5;
    let displacement = reader.u32(position + 1) - nextInstruction;
    if (priorOpcodeMask !== 0) {
      const shift = (priorOpcodeMask & 6) << 2;
      if (isSignByte((displacement >>> shift) & 0xff)) {
        displacement =
          (displacement ^ ((0x100 << shift) - 1)) - nextInstruction;
      }
      priorOpcodeMask = 0;
    }
    const signExtension = -((displacement >>> 24) & 1) << 24;
    bytes.writeUInt32LE(
      ((displacement & 0xffffff) | signExtension) >>> 0,
      position + 1,
    );
    position = nextInstruction;
  }
}

const isSignByte = (byte: number): boolean => byte === 0 || byte === 0xff;
