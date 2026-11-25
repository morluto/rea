export type RiscvWord =
  | number
  | "frame"
  | { readonly frame: readonly number[] };
export type RiscvAbiParameter = readonly [
  name: string,
  type: string,
  storage: string,
  words?: Readonly<Record<string, RiscvWord>>,
  literal?: string,
];
export interface RiscvAbiFunction {
  readonly caller?: string;
  readonly return: readonly [string, string];
  readonly parameters: readonly RiscvAbiParameter[];
  readonly variadic?: Readonly<Record<string, RiscvWord>>;
  readonly stripped?: {
    readonly return?: string;
    readonly parameters?: readonly string[];
  };
}
export interface RiscvAbiCallback {
  readonly caller: string;
  readonly pointer: string;
  readonly words: Readonly<Record<string, number>>;
  readonly literals: readonly string[];
}
export interface RiscvAbi {
  readonly prototype: string;
  readonly functions: Readonly<Record<string, RiscvAbiFunction>>;
  readonly callers: readonly string[];
  readonly callbacks: readonly RiscvAbiCallback[];
}
export type RiscvAbiName = "ilp32" | "ilp32f";
export const RISCV_ABIS: Readonly<Record<RiscvAbiName, RiscvAbi>>;
export interface RiscvCallSite {
  readonly caller: string | undefined;
  readonly target: string | undefined;
  readonly words: Readonly<
    Record<string, { word?: number; stack?: number } | undefined>
  >;
  /** Caller memory at the call, by offset from the caller's incoming `sp`. */
  readonly memory: ReadonlyMap<number, { word?: number; stack?: number }>;
}
export function riscvStorageLocations(storage: string): readonly string[];
export function assertRiscvAbiTableConsistent(name: RiscvAbiName): void;
export function parseRiscvCallSites(listing: string): readonly RiscvCallSite[];
export function inspectRiscvCallSites(
  path: string,
  callers: readonly string[],
): Promise<{
  command: string;
  version: string | undefined;
  calls: readonly RiscvCallSite[];
}>;
export function assertRiscvCallSites(
  name: RiscvAbiName,
  calls: readonly RiscvCallSite[],
): void;
export function assertRiscvStorage(
  name: RiscvAbiName,
  boundaries: Record<string, unknown>,
  options?: { readonly stripped?: boolean },
): void;
export function assertRiscvCaller(
  name: RiscvAbiName,
  caller: string,
  pseudocode: string,
  addresses: Readonly<Record<string, string>>,
  options?: { readonly stripped?: boolean },
): void;
