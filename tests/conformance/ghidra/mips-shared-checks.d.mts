import type { MipsReadelfFacts, MipsFloatAbi } from "./mips-checks.mjs";

export interface MipsSharedLoad {
  offset: number;
  address: number;
  fileSize: number;
  memorySize: number;
}
export interface MipsSharedSymbol {
  index: number;
  value: number;
  type: string;
  ndx: string;
  name: string;
}
export interface MipsSharedRelocation {
  address: number;
  type: number;
  symbolIndex: number;
}
export interface MipsSharedFacts {
  loads: MipsSharedLoad[];
  dynamic: Map<string, number>;
  symbols: Map<number, MipsSharedSymbol>;
  relocations: MipsSharedRelocation[];
}
export interface MipsSharedCoverage {
  delta: string;
  rel32_local: number;
  rel32_defined: number;
  rel32_external: number;
  tls: number;
  got_local: number;
  got_local_zero: number;
  got_defined: number;
  got_external: number;
  got_lazy_stub: number;
  got_skipped_tls: number;
}
export interface MipsSharedMapping {
  block: string;
  start: string;
  length: number;
  file_offset: number | null;
}
export function parseMipsSharedReadelf(text: string): MipsSharedFacts;
export function inspectMipsSharedReadelf(
  path: string,
  byteOrder: string,
  floatAbi: MipsFloatAbi,
): Promise<
  MipsReadelfFacts & MipsSharedFacts & { command: string; version: string }
>;
export function mipsSharedPlacementDelta(
  facts: MipsSharedFacts,
  mappings: readonly MipsSharedMapping[],
): bigint;
export function assertMipsSharedLoad(input: {
  facts: MipsSharedFacts;
  fileBytes: Buffer;
  mappings: readonly MipsSharedMapping[];
  ghidraRelocations: readonly {
    address: string;
    type: number;
    status: string;
  }[];
  words: Map<bigint, number>;
  names: readonly {
    address: string;
    value: string;
    symbol?: { external: boolean; type: string };
  }[];
  byteOrder: string;
}): MipsSharedCoverage;
