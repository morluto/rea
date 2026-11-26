import { describe, expect, it } from "vitest";
import { parseExecutableHeader } from "./binaryTarget.js";

const header = (little: boolean, machine = 263): Buffer => {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, little ? 1 : 2, 1]);
  if (little) {
    bytes.writeUInt16LE(3, 16);
    bytes.writeUInt16LE(machine, 18);
    bytes.writeUInt32LE(1, 20);
    bytes.writeUInt16LE(bytes.length, 52);
  } else {
    bytes.writeUInt16BE(3, 16);
    bytes.writeUInt16BE(machine, 18);
    bytes.writeUInt32BE(1, 20);
    bytes.writeUInt16BE(bytes.length, 52);
  }
  return bytes;
};

describe("Solana sBPF ELF header boundaries", () => {
  it.each([false, true])(
    "routes an EM_BPF header to the dedicated analyzer (little=%s)",
    (little) => {
      expect(parseExecutableHeader(header(little), "x64")).toEqual({
        ok: false,
        error:
          "unsupported ELF architecture: e_machine 263 (Solana sBPF); the native lane does not decode sBPF — analyze this file with analyze_solana_program",
      });
    },
  );
});
