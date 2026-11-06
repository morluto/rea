import type { LoongArchElfMetadata } from "../../../src/domain/binaryTargetTypes.js";

export interface LoongArchReadelfExpected {
  readonly type?: number;
  readonly flags?: number;
}

export interface LoongArchReadelfFacts {
  readonly loongarch: LoongArchElfMetadata;
  readonly symbols: Record<
    | "rea_loongarch_add"
    | "rea_loongarch_entry"
    | "rea_loongarch_probe"
    | "rea_loongarch_global",
    string
  >;
  readonly relocations: Record<string, number>;
}

export function parseLoongArchReadelf(
  text: string,
  expected?: LoongArchReadelfExpected,
): LoongArchReadelfFacts;
export function inspectLoongArchReadelf(
  path: string,
  expected?: LoongArchReadelfExpected,
): Promise<
  LoongArchReadelfFacts & { command: string; version: string; raw: string }
>;
export function analysisAddressOffset(address: unknown): bigint;
export function assertLoongArchLoadedImage(
  observations: {
    readonly language_id: string;
    readonly compiler_spec_id: string;
    readonly source_files: readonly {
      readonly original_sha256: string;
      readonly modified_sha256: string;
    }[];
  },
  sha256: string,
): void;
export function assertLoongArchGlobalBytes(bytes: unknown): void;
export function assertLoongArchProbeBytes(bytes: unknown): void;
export function assertLoongArchProbeInstructions(
  instructions: readonly string[],
  address: string,
): void;
export function assertLoongArchProbePseudocode(pseudocode: unknown): void;
