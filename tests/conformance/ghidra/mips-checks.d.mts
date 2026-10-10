import type { MipsElfMetadata } from "../../../src/domain/binaryTargetTypes.js";

export interface MipsReadelfFacts {
  mips: MipsElfMetadata;
  symbols: Record<
    | "rea_mips_entry"
    | "rea_mips_leaf"
    | "rea_mips_probe"
    | "rea_mips_global"
    | "rea_mips_marker",
    string
  >;
}
export function parseMipsReadelf(
  text: string,
  byteOrder: string,
): MipsReadelfFacts;
export function inspectMipsReadelf(
  path: string,
  byteOrder: string,
): Promise<
  MipsReadelfFacts & { command: string; version: string; raw: string }
>;
export function assertMipsLoadedImage(
  observations: unknown,
  byteOrder: string,
  sha256: string,
): void;
export function assertMipsProbe(
  move: unknown,
  branch: unknown,
  byteOrder: string,
  address: string,
): void;
export function assertMipsGlobal(bytes: string, byteOrder: string): void;
