import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
export const GHIDRA_GAME_BOY_LANGUAGE = {
  languageId: "SM83:LE:16:default",
  compilerSpecId: "default",
} as const;
export const ghidraGameBoyLimitations = (
  target: Extract<BinaryTarget, { format: "gameboy-rom" }>,
): readonly string[] => [
  ...target.gameBoy.limitations,
  "Game Boy analysis uses the caller-installed SM83 language. The Z80 instruction set is not a substitute for SM83.",
  "ROM bank 0 is mapped at 0x0000 and bank 1 at 0x4000. Later physical ROM banks are separate ROM_NNN overlays at 0x4000. These are analysis coordinates, not observed active mapper state.",
  "Static analysis does not resolve bank-switch writes or far calls. Cross-bank references and MBC1 lower-window remapping remain unknown; do not interpret a default-window call as proof of the active ROM bank.",
  "Only entry 0x100 is seeded automatically. Use explicit analysis seeds for additional code. Header/data bytes and unreachable bank code are not indiscriminately disassembled.",
  "RAM and hardware registers are uninitialized address ranges; boot ROM execution, RAM bank switching, I/O effects, interrupts and timing are not emulated. SM83 decompiler calling conventions remain heuristic.",
];
