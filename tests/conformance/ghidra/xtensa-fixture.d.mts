export const XTENSA_FIXTURE_TEXT: Buffer;
export const XTENSA_FIXTURE_SYMBOLS: Record<
  "rea_xtensa_literal" | "rea_xtensa_entry" | "rea_xtensa_leaf",
  { address: number; size: number; type: "OBJECT" | "FUNC" }
>;
export const XTENSA_FIXTURE_INSTRUCTIONS: Record<
  "entry" | "l32r" | "call8" | "retw",
  number
>;
export const XTENSA_FIXTURE_LITERAL: number;
export const XTENSA_FIXTURE_ADDEND: number;
export const XTENSA_C_FIXTURE_VALUES: {
  global: string;
  factor: number;
  constant: number;
};
export function xtensaFixtureBytes(): Buffer;
export function mutateXtensaFixture(
  bytes: Buffer,
  change: { flags?: number; type?: number; abi?: string },
): Buffer;
export function writeXtensaFixture(
  directory: string,
): Promise<{ path: string; bytes: Buffer; sha256: string }>;
export function buildXtensaCFixture(
  directory: string,
  compiler: string,
): Promise<{
  path: string;
  bytes: Buffer;
  sha256: string;
  toolchain: {
    compiler: { command: string; version: string };
    arguments: string[];
  };
  source_sha256: string;
}>;
